import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp, parseTrustProxy, SESSION_COOKIE } from '../server/app.js';
import { openDatabase, type Database } from '../server/db.js';
import { hashPassword } from '../server/security.js';

const ADMIN_PASSWORD = 'Admin setup password!';

let database: Database;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  database = await openDatabase(':memory:');
  app = await createApp({
    database,
    cookieSecure: false,
    serveStatic: false,
    sessionDays: 1,
  });
});

afterEach(async () => {
  await database.close();
});

async function insertUser(
  username: string,
  password: string,
  options: { role?: 'user' | 'admin'; active?: boolean } = {},
): Promise<number> {
  const timestamp = new Date().toISOString();
  const result = await database.prepare(`
    INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    username,
    await hashPassword(password),
    options.role ?? 'user',
    options.active === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  return Number(result.lastInsertRowid);
}

describe('first-run setup', () => {
  it('reports setup state, creates the default Admin account, and starts an authenticated session', async () => {
    const anonymous = await request(app).get('/api/auth/status').expect(200);
    expect(anonymous.body.data).toEqual({
      setupRequired: true,
      authenticated: false,
      user: null,
    });

    const agent = request.agent(app);
    const setup = await agent
      .post('/api/auth/setup')
      .send({ password: ADMIN_PASSWORD })
      .expect(201);

    expect(setup.body.data.user).toMatchObject({
      username: 'Admin',
      role: 'admin',
      isActive: true,
    });
    const setCookie = setup.headers['set-cookie'];
    const serializedCookies = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
    expect(serializedCookies).toContain(`${SESSION_COOKIE}=`);
    expect(serializedCookies).toContain('HttpOnly');
    expect(serializedCookies).toContain('SameSite=Lax');

    const authenticated = await agent.get('/api/auth/me').expect(200);
    expect(authenticated.body.data.user).toMatchObject({ username: 'Admin', role: 'admin' });

    const storedUser = await database.prepare(
      'SELECT username, role, password_hash FROM users',
    ).get() as { username: string; role: string; password_hash: string };
    expect(storedUser).toMatchObject({ username: 'Admin', role: 'admin' });
    expect(storedUser.password_hash).not.toContain(ADMIN_PASSWORD);

    const storedSession = await database.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(storedSession.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses an editable username during first-run setup', async () => {
    const setup = await request(app)
      .post('/api/auth/setup')
      .send({ username: 'Coach', password: ADMIN_PASSWORD })
      .expect(201);

    expect(setup.body.data.user).toMatchObject({ username: 'Coach', role: 'admin' });
    expect(await database.prepare('SELECT username, role FROM users').get())
      .toEqual({ username: 'Coach', role: 'admin' });
  });

  it('validates the password and permanently closes setup after the first account', async () => {
    await request(app)
      .post('/api/auth/setup')
      .send({ username: 'not a valid username', password: ADMIN_PASSWORD })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      });

    await request(app)
      .post('/api/auth/setup')
      .send({ password: 'short' })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      });

    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 0 });

    await request(app).post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);
    await request(app)
      .post('/api/auth/setup')
      .send({ password: 'Another valid password!' })
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'ALREADY_CONFIGURED' } });
      });

    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
  });

  it('does not let calls to the closed setup endpoint exhaust the login quota', async () => {
    await request(app).post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await request(app)
        .post('/api/auth/setup')
        .send({ password: 'Another valid password!' })
        .expect(409);
    }

    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Admin', password: ADMIN_PASSWORD })
      .expect(200);
  });
});

describe('proxy configuration', () => {
  it('parses direct, hop-count, boolean, and address-list settings', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});

describe('login and session lifecycle', () => {
  it('uses case-insensitive usernames and generic invalid-credential errors', async () => {
    await request(app).post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);

    const failedUnknown = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'not the password' })
      .expect(401);
    const failedPassword = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Admin', password: 'not the password' })
      .expect(401);
    expect(failedUnknown.body.error).toEqual(failedPassword.body.error);
    expect(failedPassword.body.error.code).toBe('INVALID_CREDENTIALS');

    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ username: 'aDmIn', password: ADMIN_PASSWORD })
      .expect(200);
    expect(login.body.data.user).toMatchObject({ username: 'Admin', role: 'admin' });
    await agent.get('/api/auth/me').expect(200);
  });

  it('denies disabled accounts and never creates a session for them', async () => {
    await insertUser('Disabled', 'Disabled password!', { active: false });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Disabled', password: 'Disabled password!' })
      .expect(403);

    expect(response.body).toMatchObject({ error: { code: 'ACCOUNT_DISABLED' } });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  });

  it('invalidates the server-side session at logout', async () => {
    await request(app).post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);
    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ username: 'Admin', password: ADMIN_PASSWORD })
      .expect(200);

    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rotates all sessions after a password change', async () => {
    await request(app).post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);
    const firstDevice = request.agent(app);
    const secondDevice = request.agent(app);
    await firstDevice.post('/api/auth/login').send({ username: 'Admin', password: ADMIN_PASSWORD }).expect(200);
    await secondDevice.post('/api/auth/login').send({ username: 'Admin', password: ADMIN_PASSWORD }).expect(200);

    await firstDevice
      .post('/api/auth/change-password')
      .send({ currentPassword: ADMIN_PASSWORD, newPassword: 'A newer admin password!' })
      .expect(200);

    await firstDevice.get('/api/auth/me').expect(200);
    await secondDevice.get('/api/auth/me').expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Admin', password: ADMIN_PASSWORD })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Admin', password: 'A newer admin password!' })
      .expect(200);
  });

  it('renames the signed-in account without changing its role or invalidating its session', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);

    const renamed = await agent
      .patch('/api/auth/profile')
      .send({ username: 'Coach' })
      .expect(200);
    expect(renamed.body.data).toEqual({
      user: expect.objectContaining({ username: 'Coach', role: 'admin' }),
    });

    await agent
      .get('/api/auth/me')
      .expect(200)
      .expect(({ body }: { body: { data: { user: { username: string; role: string } } } }) => {
        expect(body.data.user).toMatchObject({ username: 'Coach', role: 'admin' });
      });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });

    await request(app)
      .post('/api/auth/login')
      .send({ username: 'Admin', password: ADMIN_PASSWORD })
      .expect(401);
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'cOaCh', password: ADMIN_PASSWORD })
      .expect(200);

    const audit = await database.prepare(`
      SELECT actor_username, metadata FROM audit_log
      WHERE action = 'auth.username_changed'
    `).get() as { actor_username: string; metadata: string };
    expect(audit.actor_username).toBe('Coach');
    expect(JSON.parse(audit.metadata)).toEqual({ previousUsername: 'Admin', username: 'Coach' });
  });

  it('requires authentication and rejects usernames already used with different casing', async () => {
    await request(app)
      .patch('/api/auth/profile')
      .send({ username: 'Anonymous' })
      .expect(401);

    const agent = request.agent(app);
    await agent.post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);
    await insertUser('Taken', 'Member password!');

    await agent
      .patch('/api/auth/profile')
      .send({ username: 'tAkEn' })
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ error: { code: 'USERNAME_EXISTS' } });
      });
    expect(await database.prepare('SELECT username, role FROM users WHERE role = ?').get('admin'))
      .toEqual({ username: 'Admin', role: 'admin' });
  });
});

describe('invitation activation', () => {
  it('creates a pending account, consumes its one-time code, and starts a session', async () => {
    const admin = request.agent(app);
    await admin.post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);
    const created = await admin
      .post('/api/admin/users')
      .send({ username: 'Invited', role: 'user' })
      .expect(201);
    const inviteCode = created.body.data.inviteCode as string;
    expect(inviteCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.body.data.user).toMatchObject({
      username: 'Invited',
      requiresPasswordSetup: true,
    });
    expect(await database.prepare(`
      SELECT password_hash, invite_code_hash, requires_password_setup
      FROM users WHERE username = 'Invited'
    `).get()).toMatchObject({
      password_hash: '',
      requires_password_setup: 1,
      invite_code_hash: expect.not.stringContaining(inviteCode),
    });

    const pendingLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'Invited', password: 'anything' })
      .expect(409);
    expect(pendingLogin.body).toMatchObject({ error: { code: 'PASSWORD_SETUP_REQUIRED' } });
    await request(app)
      .post('/api/auth/activate')
      .send({ username: 'Invited', inviteCode: `${inviteCode.slice(0, -1)}x`, newPassword: 'Activated password!' })
      .expect(400);

    const invited = request.agent(app);
    const activated = await invited
      .post('/api/auth/activate')
      .send({ username: 'Invited', inviteCode, newPassword: 'Activated password!' })
      .expect(200);
    expect(activated.body.data.user).toMatchObject({
      username: 'Invited',
      requiresPasswordSetup: false,
    });
    await invited.get('/api/auth/me').expect(200);
    expect(await database.prepare(`
      SELECT invite_code_hash, requires_password_setup FROM users WHERE username = 'Invited'
    `).get()).toEqual({ invite_code_hash: null, requires_password_setup: 0 });
    await request(app)
      .post('/api/auth/activate')
      .send({ username: 'Invited', inviteCode, newPassword: 'Another password!' })
      .expect(400);
  });

  it('rejects the removed admin-supplied-password shape', async () => {
    const admin = request.agent(app);
    await admin.post('/api/auth/setup').send({ password: ADMIN_PASSWORD }).expect(201);
    await admin
      .post('/api/admin/users')
      .send({ username: 'OldShape', role: 'user', password: 'Admin chosen password!' })
      .expect(400);
  });
});
