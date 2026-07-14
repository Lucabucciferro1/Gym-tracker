import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../server/app.js';
import { openDatabase, type Database } from '../server/db.js';

let database: Database;
let temporaryDirectory: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'forge-admin-test-'));
  database = openDatabase(join(temporaryDirectory, 'forge.db'));
  app = createApp({ database, cookieSecure: false, serveStatic: false });
});

afterEach(() => {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function setupAdmin() {
  const agent = request.agent(app);
  const setup = await agent
    .post('/api/auth/setup')
    .send({ password: 'Admin setup password!' })
    .expect(201);
  return { agent, user: setup.body.data.user as { id: number; username: string; role: string } };
}

async function createUser(
  admin: ReturnType<typeof request.agent>,
  input: { username: string; password: string; role?: 'user' | 'admin' },
) {
  const response = await admin
    .post('/api/admin/users')
    .send({ username: input.username, role: input.role ?? 'user' })
    .expect(201);
  const activation = await request(app)
    .post('/api/auth/activate')
    .send({ username: input.username, inviteCode: response.body.data.inviteCode, newPassword: input.password })
    .expect(200);
  return activation.body.data.user as { id: number; username: string; role: string; isActive: boolean };
}

async function login(username: string, password: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username, password }).expect(200);
  return agent;
}

describe('admin authorization', () => {
  it('denies every administrative capability to a standard user', async () => {
    const { agent: admin, user: adminUser } = await setupAdmin();
    const member = await createUser(admin, { username: 'Member', password: 'Member password!' });
    const memberAgent = await login('Member', 'Member password!');

    const denialRequests = [
      () => memberAgent.get('/api/admin/overview'),
      () => memberAgent.get('/api/admin/users'),
      () => memberAgent.get('/api/admin/audit'),
      () => memberAgent.post('/api/admin/users').send({ username: 'Injected', role: 'user' }),
      () => memberAgent.patch(`/api/admin/users/${member.id}/status`).send({ isActive: false }),
      () => memberAgent.post(`/api/admin/users/${adminUser.id}/reset-invite`),
      () => memberAgent.delete(`/api/admin/users/${adminUser.id}`),
    ];

    // A Supertest agent owns one cookie jar and ephemeral server. Running these
    // requests concurrently can reset a connection during teardown on Linux.
    for (const sendDenialRequest of denialRequests) {
      const denial = await sendDenialRequest();
      expect(denial.status).toBe(403);
      expect(denial.body).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } });
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'Injected'").get())
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT is_active FROM users WHERE id = ?').get(member.id))
      .toEqual({ is_active: 1 });
  });

  it('does not rely on an Admin-like username to grant privileges', async () => {
    const { agent: admin } = await setupAdmin();
    const lookalike = await createUser(admin, {
      username: 'Admin-copy',
      password: 'Lookalike password!',
      role: 'user',
    });
    const lookalikeAgent = await login(lookalike.username, 'Lookalike password!');

    await lookalikeAgent.get('/api/admin/overview').expect(403);
    expect(lookalike.role).toBe('user');
  });

  it('rejects case-insensitive duplicate usernames without creating a second account', async () => {
    const { agent: admin } = await setupAdmin();
    await createUser(admin, { username: 'Member', password: 'Member password!' });

    const duplicate = await admin
      .post('/api/admin/users')
      .send({ username: 'mEmBeR', role: 'user' })
      .expect(409);

    expect(duplicate.body).toMatchObject({ error: { code: 'USERNAME_EXISTS' } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'Member'").get())
      .toEqual({ count: 1 });
  });

  it('keeps invited friends as members so the first-run account remains the sole administrator', async () => {
    const { agent: admin } = await setupAdmin();
    await admin
      .post('/api/admin/users')
      .send({ username: 'PeerAdmin', role: 'admin' })
      .expect(400);
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get())
      .toEqual({ count: 1 });
  });
});

describe('admin account safeguards', () => {
  it('prevents an admin from disabling, deleting, or administratively resetting itself', async () => {
    const { agent: admin, user: adminUser } = await setupAdmin();

    const disable = await admin
      .patch(`/api/admin/users/${adminUser.id}/status`)
      .send({ isActive: false })
      .expect(400);
    expect(disable.body).toMatchObject({ error: { code: 'CANNOT_DISABLE_SELF' } });

    const reset = await admin
      .post(`/api/admin/users/${adminUser.id}/reset-invite`)
      .expect(400);
    expect(reset.body).toMatchObject({ error: { code: 'CANNOT_RESET_SELF' } });

    const deletion = await admin.delete(`/api/admin/users/${adminUser.id}`).expect(400);
    expect(deletion.body).toMatchObject({ error: { code: 'CANNOT_DELETE_SELF' } });
    await admin.get('/api/auth/me').expect(200);
  });

  it('disables an account, invalidates its active sessions, and can reactivate it', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await createUser(admin, { username: 'Member', password: 'Member password!' });
    const memberAgent = await login('Member', 'Member password!');

    const disabled = await admin
      .patch(`/api/admin/users/${member.id}/status`)
      .send({ isActive: false })
      .expect(200);
    expect(disabled.body.data.user.isActive).toBe(false);
    await memberAgent.get('/api/auth/me').expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Member', password: 'Member password!' })
      .expect(403);

    await admin
      .patch(`/api/admin/users/${member.id}/status`)
      .send({ isActive: true })
      .expect(200);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Member', password: 'Member password!' })
      .expect(200);
  });

  it('resets another user invite and invalidates all of their active sessions', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await createUser(admin, { username: 'Member', password: 'Member password!' });
    const memberAgent = await login('Member', 'Member password!');

    const reset = await admin
      .post(`/api/admin/users/${member.id}/reset-invite`)
      .expect(200);

    await memberAgent.get('/api/auth/me').expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Member', password: 'Member password!' })
      .expect(409);
    await request(app)
      .post('/api/auth/activate')
      .send({
        username: 'Member',
        inviteCode: reset.body.data.inviteCode,
        newPassword: 'Replacement password!',
      })
      .expect(200);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Member', password: 'Member password!' })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Member', password: 'Replacement password!' })
      .expect(200);
  });

  it('re-enables a disabled account when issuing a replacement invite', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await createUser(admin, { username: 'Member', password: 'Member password!' });
    await admin
      .patch(`/api/admin/users/${member.id}/status`)
      .send({ isActive: false })
      .expect(200);

    const reset = await admin
      .post(`/api/admin/users/${member.id}/reset-invite`)
      .expect(200);
    expect(reset.body.data.user).toMatchObject({ isActive: true, requiresPasswordSetup: true });
    await request(app)
      .post('/api/auth/activate')
      .send({
        username: 'Member',
        inviteCode: reset.body.data.inviteCode,
        newPassword: 'Replacement password!',
      })
      .expect(200);
  });

  it('deletes another user with all owned data and preserves an audit record', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await createUser(admin, { username: 'Disposable', password: 'Disposable password!' });
    const memberAgent = await login('Disposable', 'Disposable password!');
    const parts = await memberAgent.get('/api/body-parts').expect(200);
    const exercises = await memberAgent.get('/api/exercises').expect(200);
    await memberAgent
      .post(`/api/body-parts/${parts.body.data.bodyParts[0].id}/measurements`)
      .send({ value: 75 })
      .expect(201);
    await memberAgent
      .post(`/api/exercises/${exercises.body.data.exercises[0].id}/lifts`)
      .send({ weight: 100, reps: 1 })
      .expect(201);

    await admin.delete(`/api/admin/users/${member.id}`).expect(200);

    expect(database.prepare('SELECT id FROM users WHERE id = ?').get(member.id)).toBeUndefined();
    expect(database.prepare('SELECT COUNT(*) AS count FROM body_parts WHERE user_id = ?').get(member.id))
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM exercises WHERE user_id = ?').get(member.id))
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT action, target_id FROM audit_log
      WHERE action = 'admin.user_deleted' AND target_id = ?
    `).get(String(member.id))).toEqual({ action: 'admin.user_deleted', target_id: String(member.id) });

    expect(database.prepare(`
      SELECT actor_user_id, actor_username FROM audit_log
      WHERE action = 'auth.login' AND actor_username = 'Disposable'
    `).get()).toEqual({ actor_user_id: null, actor_username: 'Disposable' });
    const audit = await admin.get('/api/admin/audit?limit=100').expect(200);
    const deletedActorEvent = audit.body.data.auditEntries.find(
      (event: { action: string; actorUsername: string | null }) =>
        event.action === 'auth.login' && event.actorUsername === 'Disposable',
    );
    expect(deletedActorEvent).toMatchObject({ actorUserId: null, actorUsername: 'Disposable' });
    const trainingEvents = audit.body.data.auditEntries.filter(
      (event: { targetType: string }) => ['body_part', 'measurement', 'exercise', 'lift'].includes(event.targetType),
    );
    expect(trainingEvents.length).toBeGreaterThan(0);
    expect(trainingEvents.every((event: { metadata: unknown }) => event.metadata === null)).toBe(true);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE target_type IN ('body_part', 'measurement', 'exercise', 'lift') AND metadata IS NOT NULL
    `).get()).toEqual({ count: 0 });
  });
});

describe('admin audit privacy', () => {
  it('redacts private training metadata defensively in overview and audit responses', async () => {
    const { agent: admin, user: adminUser } = await setupAdmin();
    const timestamp = new Date().toISOString();
    database.prepare(`
      INSERT INTO audit_log (
        actor_user_id, actor_username, action, target_type, target_id, metadata, created_at
      ) VALUES (?, ?, 'measurement.updated', 'measurement', '999', ?, ?)
    `).run(
      adminUser.id,
      adminUser.username,
      JSON.stringify({ value: 77.7, note: 'private health note', recordedAt: timestamp }),
      timestamp,
    );

    const overview = await admin.get('/api/admin/overview').expect(200);
    const overviewEvent = overview.body.data.recentAudit.find(
      (event: { targetId: string }) => event.targetId === '999',
    );
    expect(overviewEvent.metadata).toBeNull();

    const audit = await admin.get('/api/admin/audit?limit=100').expect(200);
    const auditEvent = audit.body.data.auditEntries.find(
      (event: { targetId: string }) => event.targetId === '999',
    );
    expect(auditEvent.metadata).toBeNull();
    expect(JSON.stringify({ overviewEvent, auditEvent })).not.toContain('private health note');
    expect(JSON.stringify({ overviewEvent, auditEvent })).not.toContain('77.7');
  });
});
