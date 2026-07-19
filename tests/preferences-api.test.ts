import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../server/app.js';
import {
  DEFAULT_MOBILE_NAVIGATION_ITEMS,
  openDatabase,
  replaceUserMobileNavigation,
  type Database,
} from '../server/db.js';

let database: Database;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  database = await openDatabase(':memory:');
  app = await createApp({ database, cookieSecure: false, serveStatic: false });
});

afterEach(async () => {
  await database.close();
});

async function setupAdmin() {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/auth/setup')
    .send({ password: 'Admin setup password!' })
    .expect(201);
  return { agent, user: response.body.data.user as { id: number; username: string } };
}

async function inviteAndActivate(admin: ReturnType<typeof request.agent>, username: string) {
  const invitation = await admin
    .post('/api/admin/users')
    .send({ username, role: 'user' })
    .expect(201);
  const agent = request.agent(app);
  const password = `${username} secure password!`;
  const activation = await agent
    .post('/api/auth/activate')
    .send({ username, inviteCode: invitation.body.data.inviteCode, newPassword: password })
    .expect(200);
  return {
    agent,
    password,
    user: activation.body.data.user as { id: number; username: string },
  };
}

describe('mobile navigation preferences', () => {
  it('requires authentication for reads, replacement, and reset', async () => {
    await request(app).get('/api/preferences/mobile-navigation').expect(401);
    await request(app)
      .put('/api/preferences/mobile-navigation')
      .send({ items: ['dashboard', 'measurements', 'lifts', 'workout'] })
      .expect(401);
    await request(app).post('/api/preferences/mobile-navigation/reset').expect(401);
  });

  it('seeds isolated defaults and persists each user order across sessions', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await inviteAndActivate(admin, 'Member');

    const defaults = { items: [...DEFAULT_MOBILE_NAVIGATION_ITEMS] };
    expect((await admin.get('/api/preferences/mobile-navigation').expect(200)).body.data).toEqual(defaults);
    expect((await member.agent.get('/api/preferences/mobile-navigation').expect(200)).body.data).toEqual(defaults);

    const memberItems = ['meals', 'sharing', 'measurements', 'lifts'];
    expect((await member.agent
      .put('/api/preferences/mobile-navigation')
      .send({ items: memberItems })
      .expect(200)).body.data).toEqual({ items: memberItems });
    expect((await admin.get('/api/preferences/mobile-navigation').expect(200)).body.data).toEqual(defaults);

    await member.agent.post('/api/auth/logout').expect(200);
    await member.agent
      .post('/api/auth/login')
      .send({ username: member.user.username, password: member.password })
      .expect(200);
    expect((await member.agent.get('/api/preferences/mobile-navigation').expect(200)).body.data)
      .toEqual({ items: memberItems });
  });

  it('rejects invalid or unauthorized destinations without changing the saved order', async () => {
    const { agent: admin } = await setupAdmin();
    const member = await inviteAndActivate(admin, 'Member');
    const savedItems = ['meals', 'sharing', 'measurements', 'lifts'];
    await member.agent.put('/api/preferences/mobile-navigation').send({ items: savedItems }).expect(200);

    const invalidBodies = [
      { items: ['dashboard', 'measurements', 'lifts'] },
      { items: ['dashboard', 'measurements', 'lifts', 'workout', 'meals'] },
      { items: ['dashboard', 'dashboard', 'lifts', 'workout'] },
      { items: ['dashboard', 'measurements', 'lifts', 'more'] },
      { items: ['dashboard', 'measurements', 'lifts', '/external'] },
      { items: ['Dashboard', 'measurements', 'lifts', 'workout'] },
      { items: ['dashboard', 'measurements', 'lifts', 'workout'], unexpected: true },
    ];
    for (const body of invalidBodies) {
      const response = await member.agent.put('/api/preferences/mobile-navigation').send(body).expect(400);
      expect(response.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }

    const forbidden = await member.agent
      .put('/api/preferences/mobile-navigation')
      .send({ items: ['dashboard', 'measurements', 'lifts', 'admin'] })
      .expect(403);
    expect(forbidden.body).toMatchObject({ error: { code: 'NAV_ITEM_FORBIDDEN' } });
    expect((await member.agent.get('/api/preferences/mobile-navigation').expect(200)).body.data)
      .toEqual({ items: savedItems });
  });

  it('allows an admin shortcut and resets preferences to server-owned defaults', async () => {
    const { agent: admin, user } = await setupAdmin();
    const items = ['admin', 'meals', 'sharing', 'dashboard'];
    await admin.put('/api/preferences/mobile-navigation').send({ items }).expect(200);
    expect((await admin.get('/api/preferences/mobile-navigation').expect(200)).body.data).toEqual({ items });

    const reset = await admin.post('/api/preferences/mobile-navigation/reset').expect(200);
    expect(reset.body.data).toEqual({ items: [...DEFAULT_MOBILE_NAVIGATION_ITEMS] });
    expect(await database.prepare(`
      SELECT action, target_id FROM audit_log
      WHERE action IN ('preferences.mobile_navigation_updated', 'preferences.mobile_navigation_reset')
      ORDER BY id ASC
    `).all()).toEqual([
      { action: 'preferences.mobile_navigation_updated', target_id: String(user.id) },
      { action: 'preferences.mobile_navigation_reset', target_id: String(user.id) },
    ]);
  });

  it('repairs incomplete rows and removes an admin destination from a member account', async () => {
    const { agent: admin, user: adminUser } = await setupAdmin();
    const member = await inviteAndActivate(admin, 'Member');

    await database.prepare(`
      DELETE FROM mobile_navigation_items WHERE user_id = ? AND position = 2
    `).run(adminUser.id);
    expect((await admin.get('/api/preferences/mobile-navigation').expect(200)).body.data)
      .toEqual({ items: [...DEFAULT_MOBILE_NAVIGATION_ITEMS] });
    expect(await database.prepare(`
      SELECT COUNT(*) AS count FROM mobile_navigation_items WHERE user_id = ?
    `).get(adminUser.id)).toEqual({ count: 4 });

    await replaceUserMobileNavigation(
      database,
      member.user.id,
      ['admin', 'meals', 'sharing', 'dashboard'],
    );
    expect((await member.agent.get('/api/preferences/mobile-navigation').expect(200)).body.data)
      .toEqual({ items: [...DEFAULT_MOBILE_NAVIGATION_ITEMS] });
    expect(await database.prepare(`
      SELECT destination FROM mobile_navigation_items
      WHERE user_id = ? ORDER BY position ASC
    `).all(member.user.id)).toEqual(
      DEFAULT_MOBILE_NAVIGATION_ITEMS.map((destination) => ({ destination })),
    );
  });

  it('never leaves an interleaved order after concurrent complete replacements', async () => {
    const { agent } = await setupAdmin();
    const first = ['dashboard', 'meals', 'sharing', 'workout'];
    const second = ['admin', 'lifts', 'measurements', 'meals'];
    await Promise.all([
      agent.put('/api/preferences/mobile-navigation').send({ items: first }).expect(200),
      agent.put('/api/preferences/mobile-navigation').send({ items: second }).expect(200),
    ]);

    const stored = (await agent.get('/api/preferences/mobile-navigation').expect(200)).body.data.items;
    expect([first, second]).toContainEqual(stored);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM mobile_navigation_items').get())
      .toEqual({ count: 4 });
  });
});
