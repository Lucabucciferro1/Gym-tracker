import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../server/app.js';
import { initializeDatabase, openDatabase, type Database } from '../server/db.js';

let database: Database;
let temporaryDirectory: string | undefined;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  database = await openDatabase(':memory:');
  app = await createApp({ database, cookieSecure: false, serveStatic: false });
});

afterEach(async () => {
  await database.close();
  if (!temporaryDirectory) return;
  try {
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || code !== 'EPERM') throw error;
  }
  temporaryDirectory = undefined;
});

async function setupAdmin() {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/auth/setup')
    .send({ password: 'Admin setup password!' })
    .expect(201);
  return { agent, user: response.body.data.user as { id: number } };
}

async function inviteAndActivate(admin: ReturnType<typeof request.agent>, username: string) {
  const invitation = await admin
    .post('/api/admin/users')
    .send({ username, role: 'user' })
    .expect(201);
  const agent = request.agent(app);
  const activation = await agent
    .post('/api/auth/activate')
    .send({
      username,
      inviteCode: invitation.body.data.inviteCode,
      newPassword: `${username} secure password!`,
    })
    .expect(200);
  return { agent, user: activation.body.data.user as { id: number } };
}

function idsOf(resources: Array<{ id: number }>): number[] {
  return resources.map((resource) => resource.id);
}

describe('persisted resource ordering', () => {
  it('requires authentication and persists body-part and exercise order everywhere it is projected', async () => {
    await request(app).put('/api/body-parts/order').send({ ids: [] }).expect(401);
    await request(app).put('/api/exercises/order').send({ ids: [] }).expect(401);

    const owner = await setupAdmin();
    const viewer = await inviteAndActivate(owner.agent, 'Viewer');
    const initialParts = (await owner.agent.get('/api/body-parts').expect(200)).body.data.bodyParts;
    const initialExercises = (await owner.agent.get('/api/exercises').expect(200)).body.data.exercises;
    expect(initialParts.map((part: { name: string }) => part.name)).toEqual([
      'Body Weight', 'Chest', 'Waist', 'Hips', 'Left Arm', 'Right Arm', 'Left Thigh', 'Right Thigh', 'Neck',
    ]);
    expect(initialExercises.map((exercise: { name: string }) => exercise.name)).toEqual([
      'Bench Press', 'Back Squat', 'Deadlift', 'Overhead Press', 'Barbell Row',
    ]);

    const partOrder = idsOf(initialParts).reverse();
    const exerciseOrder = idsOf(initialExercises).reverse();
    const reorderedParts = await owner.agent
      .put('/api/body-parts/order')
      .send({ ids: partOrder })
      .expect(200);
    const reorderedExercises = await owner.agent
      .put('/api/exercises/order')
      .send({ ids: exerciseOrder })
      .expect(200);
    expect(idsOf(reorderedParts.body.data.bodyParts)).toEqual(partOrder);
    expect(reorderedParts.body.data.bodyParts.map((part: { sortOrder: number }) => part.sortOrder))
      .toEqual(partOrder.map((_, index) => index));
    expect(idsOf(reorderedExercises.body.data.exercises)).toEqual(exerciseOrder);
    expect(reorderedExercises.body.data.exercises.map((exercise: { sortOrder: number }) => exercise.sortOrder))
      .toEqual(exerciseOrder.map((_, index) => index));

    expect(idsOf((await owner.agent.get('/api/body-parts').expect(200)).body.data.bodyParts)).toEqual(partOrder);
    expect(idsOf((await owner.agent.get('/api/exercises').expect(200)).body.data.exercises)).toEqual(exerciseOrder);

    const createdPart = await owner.agent
      .post('/api/body-parts')
      .send({ name: 'Forearms' })
      .expect(201);
    const createdExercise = await owner.agent
      .post('/api/exercises')
      .send({ name: 'Pull-up' })
      .expect(201);
    expect(createdPart.body.data.bodyPart.sortOrder).toBe(partOrder.length);
    expect(createdExercise.body.data.exercise.sortOrder).toBe(exerciseOrder.length);
    const expectedParts = [...partOrder, createdPart.body.data.bodyPart.id as number];
    const expectedExercises = [...exerciseOrder, createdExercise.body.data.exercise.id as number];

    const exported = await owner.agent.get('/api/export').expect(200);
    expect(idsOf(exported.body.data.bodyParts)).toEqual(expectedParts);
    expect(idsOf(exported.body.data.exercises)).toEqual(expectedExercises);

    await owner.agent
      .post('/api/sharing')
      .send({ viewerUserId: viewer.user.id, shareMeasurements: true, shareLifts: true })
      .expect(201);
    const shared = await viewer.agent.get(`/api/shared/${owner.user.id}`).expect(200);
    expect(shared.body.data.measurements.map((item: { bodyPart: { id: number } }) => item.bodyPart.id))
      .toEqual(expectedParts);
    expect(shared.body.data.lifts.map((item: { exercise: { id: number } }) => item.exercise.id))
      .toEqual(expectedExercises);

    expect(await database.prepare(`
      SELECT action, target_type, target_id, metadata FROM audit_log
      WHERE action IN ('body_parts.reordered', 'exercises.reordered') ORDER BY id
    `).all()).toEqual([
      { action: 'body_parts.reordered', target_type: 'body_part', target_id: null, metadata: null },
      { action: 'exercises.reordered', target_type: 'exercise', target_id: null, metadata: null },
    ]);
  });

  it('rejects duplicate, missing, extra, and cross-user IDs without partially changing either order', async () => {
    const owner = await setupAdmin();
    const other = await inviteAndActivate(owner.agent, 'Other');
    const ownerPartIds = idsOf((await owner.agent.get('/api/body-parts').expect(200)).body.data.bodyParts);
    const ownerExerciseIds = idsOf((await owner.agent.get('/api/exercises').expect(200)).body.data.exercises);
    const otherPartIds = idsOf((await other.agent.get('/api/body-parts').expect(200)).body.data.bodyParts);
    const otherExerciseIds = idsOf((await other.agent.get('/api/exercises').expect(200)).body.data.exercises);

    const invalidPartOrders = [
      ownerPartIds.slice(0, -1),
      [...ownerPartIds, otherPartIds[0]],
      [ownerPartIds[0], ownerPartIds[0], ...ownerPartIds.slice(2)],
      [otherPartIds[0], ...ownerPartIds.slice(1)],
    ];
    for (const ids of invalidPartOrders) {
      const response = await owner.agent.put('/api/body-parts/order').send({ ids }).expect(400);
      expect(response.body).toMatchObject({ error: { code: 'ORDER_IDS_MISMATCH' } });
      expect(idsOf((await owner.agent.get('/api/body-parts').expect(200)).body.data.bodyParts))
        .toEqual(ownerPartIds);
    }

    const invalidExerciseOrders = [
      ownerExerciseIds.slice(0, -1),
      [...ownerExerciseIds, otherExerciseIds[0]],
      [ownerExerciseIds[0], ownerExerciseIds[0], ...ownerExerciseIds.slice(2)],
      [otherExerciseIds[0], ...ownerExerciseIds.slice(1)],
    ];
    for (const ids of invalidExerciseOrders) {
      const response = await owner.agent.put('/api/exercises/order').send({ ids }).expect(400);
      expect(response.body).toMatchObject({ error: { code: 'ORDER_IDS_MISMATCH' } });
      expect(idsOf((await owner.agent.get('/api/exercises').expect(200)).body.data.exercises))
        .toEqual(ownerExerciseIds);
    }

    await other.agent.put('/api/body-parts/order').send({ ids: ownerPartIds }).expect(400);
    await other.agent.put('/api/exercises/order').send({ ids: ownerExerciseIds }).expect(400);
    expect(idsOf((await other.agent.get('/api/body-parts').expect(200)).body.data.bodyParts)).toEqual(otherPartIds);
    expect(idsOf((await other.agent.get('/api/exercises').expect(200)).body.data.exercises)).toEqual(otherExerciseIds);
    expect(await database.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE action IN ('body_parts.reordered', 'exercises.reordered')
    `).get()).toEqual({ count: 0 });
  });
});

describe('ordering migration', () => {
  it('backfills legacy rows in their former alphabetical order exactly once', async () => {
    await database.close();
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'forge-ordering-legacy-test-'));
    const databasePath = join(temporaryDirectory, 'legacy.db');
    const legacy = new DatabaseSync(databasePath);
    const timestamp = new Date().toISOString();
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE body_parts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        unit TEXT NOT NULL DEFAULT 'cm',
        color TEXT NOT NULL DEFAULT '#f97316',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );
      CREATE TABLE exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        category TEXT NOT NULL DEFAULT 'Strength',
        unit TEXT NOT NULL DEFAULT 'kg',
        color TEXT NOT NULL DEFAULT '#f97316',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );
      INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
      VALUES ('Legacy', 'test-only-hash', 'user', 1, '${timestamp}', '${timestamp}');
      INSERT INTO body_parts (user_id, name, created_at, updated_at) VALUES
        (1, 'Zed', '${timestamp}', '${timestamp}'),
        (1, 'alpha', '${timestamp}', '${timestamp}'),
        (1, 'Middle', '${timestamp}', '${timestamp}');
      INSERT INTO exercises (user_id, name, created_at, updated_at) VALUES
        (1, 'Zercher squat', '${timestamp}', '${timestamp}'),
        (1, 'bench press', '${timestamp}', '${timestamp}'),
        (1, 'Deadlift', '${timestamp}', '${timestamp}');
    `);
    legacy.close();

    database = await openDatabase(databasePath);
    expect(await database.prepare(`
      SELECT name, sort_order FROM body_parts ORDER BY sort_order, id
    `).all()).toEqual([
      { name: 'alpha', sort_order: 0 },
      { name: 'Middle', sort_order: 1 },
      { name: 'Zed', sort_order: 2 },
    ]);
    expect(await database.prepare(`
      SELECT name, sort_order FROM exercises ORDER BY sort_order, id
    `).all()).toEqual([
      { name: 'bench press', sort_order: 0 },
      { name: 'Deadlift', sort_order: 1 },
      { name: 'Zercher squat', sort_order: 2 },
    ]);

    await database.prepare(`UPDATE body_parts SET sort_order = CASE name
      WHEN 'Zed' THEN 0 WHEN 'Middle' THEN 1 ELSE 2 END`).run();
    await database.prepare(`UPDATE exercises SET sort_order = CASE name
      WHEN 'Zercher squat' THEN 0 WHEN 'Deadlift' THEN 1 ELSE 2 END`).run();
    await initializeDatabase(database);
    expect(await database.prepare('SELECT name FROM body_parts ORDER BY sort_order, id').all())
      .toEqual([{ name: 'Zed' }, { name: 'Middle' }, { name: 'alpha' }]);
    expect(await database.prepare('SELECT name FROM exercises ORDER BY sort_order, id').all())
      .toEqual([{ name: 'Zercher squat' }, { name: 'Deadlift' }, { name: 'bench press' }]);
  });
});
