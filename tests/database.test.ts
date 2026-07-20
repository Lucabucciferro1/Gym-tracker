import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MOBILE_NAVIGATION_ITEMS,
  openDatabase,
  replaceUserMobileNavigation,
  runTransaction,
  seedUserDefaults,
  seedUserMobileNavigation,
  seedUserPlans,
  writeAudit,
  type Database,
} from '../server/db.js';

let database: Database | undefined;
let temporaryDirectory: string | undefined;

async function openTemporaryDatabase(): Promise<Database> {
  database = await openDatabase(':memory:');
  return database;
}

async function insertUser(db: Database, username: string, role: 'user' | 'admin' = 'user'): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(username, 'test-only-hash', role, now, now);
  return Number(result.lastInsertRowid);
}

afterEach(async () => {
  if (database) await database.close();
  database = undefined;
  if (temporaryDirectory) {
    try {
      rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || code !== 'EPERM') throw error;
    }
  }
  temporaryDirectory = undefined;
});

describe('database initialization', () => {
  it('requires an authentication token for remote Turso databases', async () => {
    await expect(openDatabase({ url: 'libsql://forge-example.turso.io' }))
      .rejects.toThrow('TURSO_AUTH_TOKEN is required');
  });

  it('creates an isolated SQLite database and enables foreign-key enforcement', async () => {
    const db = await openTemporaryDatabase();

    expect(await db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get())
      .toEqual({ name: 'users' });
  });

  it('seeds each user with their own defaults and remains idempotent', async () => {
    const db = await openTemporaryDatabase();
    const ownerId = await insertUser(db, 'Owner');
    const memberId = await insertUser(db, 'Member');

    await seedUserDefaults(db, ownerId);
    await seedUserDefaults(db, ownerId);
    await seedUserDefaults(db, memberId);

    const counts = await db.prepare(`
      SELECT user_id, COUNT(*) AS count
      FROM body_parts
      GROUP BY user_id
      ORDER BY user_id
    `).all();
    expect(counts).toEqual([
      { user_id: ownerId, count: 9 },
      { user_id: memberId, count: 9 },
    ]);

    const ownerBench = await db.prepare(
      "SELECT id FROM exercises WHERE user_id = ? AND name = 'Bench Press'",
    ).get(ownerId);
    const memberBench = await db.prepare(
      "SELECT id FROM exercises WHERE user_id = ? AND name = 'Bench Press'",
    ).get(memberId);
    expect(ownerBench).toBeTruthy();
    expect(memberBench).toBeTruthy();
    expect(ownerBench).not.toEqual(memberBench);
    expect(await db.prepare(`
      SELECT destination FROM mobile_navigation_items
      WHERE user_id = ? ORDER BY position ASC
    `).all(ownerId)).toEqual(DEFAULT_MOBILE_NAVIGATION_ITEMS.map((destination) => ({ destination })));
  });

  it('avoids orphaned defaults and audit actors when foreign-key enforcement is unavailable', async () => {
    const db = await openTemporaryDatabase();
    await db.prepare('PRAGMA foreign_keys = OFF').run();

    await seedUserDefaults(db, 999_999);
    await seedUserMobileNavigation(db, 999_999);
    await seedUserPlans(db, 999_999);
    await writeAudit(db, {
      actorUserId: 999_999,
      action: 'test.missing_actor',
      targetType: 'test',
    });

    expect(await db.prepare('SELECT COUNT(*) AS count FROM body_parts').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM exercises').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM workout_days').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM meal_plan_settings').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mobile_navigation_items').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT actor_user_id, actor_username FROM audit_log').get())
      .toEqual({ actor_user_id: null, actor_username: null });
  });

  it('rolls back every statement when a transaction fails', async () => {
    const db = await openTemporaryDatabase();

    await expect(runTransaction(db, async () => {
      await insertUser(db, 'Should Roll Back');
      throw new Error('stop');
    })).rejects.toThrow('stop');

    expect(await db.prepare("SELECT id FROM users WHERE username = 'Should Roll Back'").get())
      .toBeUndefined();
  });

  it('serializes concurrent transactions on the local fallback connection', async () => {
    const db = await openTemporaryDatabase();
    let signalStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runTransaction(db, async () => {
      signalStarted();
      await holdFirst;
      await insertUser(db, 'First local transaction');
    });
    await started;
    const second = runTransaction(db, async () => {
      await insertUser(db, 'Second local transaction');
    });
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 2 });
  });

  it('atomically replaces navigation rows when an insert fails partway through', async () => {
    const db = await openTemporaryDatabase();
    const userId = await insertUser(db, 'Navigation owner');
    await seedUserDefaults(db, userId);
    const original = ['meals', 'workout', 'lifts', 'measurements'] as const;
    await replaceUserMobileNavigation(db, userId, original);
    await db.exec(`
      CREATE TRIGGER reject_sharing_navigation
      BEFORE INSERT ON mobile_navigation_items
      WHEN NEW.destination = 'sharing'
      BEGIN
        SELECT RAISE(ABORT, 'test navigation failure');
      END;
    `);

    await expect(replaceUserMobileNavigation(
      db,
      userId,
      ['dashboard', 'meals', 'sharing', 'workout'],
    )).rejects.toThrow();
    expect(await db.prepare(`
      SELECT destination FROM mobile_navigation_items
      WHERE user_id = ? ORDER BY position ASC
    `).all(userId)).toEqual(original.map((destination) => ({ destination })));
  });

  it('cascades a deleted user through their private measurement and lift data', async () => {
    const db = await openTemporaryDatabase();
    const userId = await insertUser(db, 'Disposable');
    await seedUserDefaults(db, userId);
    const now = new Date().toISOString();
    const bodyPart = await db.prepare('SELECT id FROM body_parts WHERE user_id = ? LIMIT 1').get(userId) as { id: number };
    const exercise = await db.prepare('SELECT id FROM exercises WHERE user_id = ? LIMIT 1').get(userId) as { id: number };

    await db.prepare(`
      INSERT INTO measurements (body_part_id, value, recorded_at, created_at, updated_at)
      VALUES (?, 80, ?, ?, ?)
    `).run(bodyPart.id, now, now, now);
    await db.prepare(`
      INSERT INTO lift_records (exercise_id, weight, reps, recorded_at, created_at, updated_at)
      VALUES (?, 100, 1, ?, ?, ?)
    `).run(exercise.id, now, now, now);

    await db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    expect(await db.prepare('SELECT COUNT(*) AS count FROM measurements').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM lift_records').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM body_parts').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM exercises').get()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mobile_navigation_items').get()).toEqual({ count: 0 });
  });

  it('migrates legacy audit logs, snapshots actors, and scrubs private training metadata', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'forge-legacy-test-'));
    const databasePath = join(temporaryDirectory, 'forge.db');
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
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
      VALUES ('Legacy member', 'test-only-hash', 'user', 1, ?, ?)
    `).run(timestamp, timestamp);
    legacy.prepare(`
      INSERT INTO audit_log (actor_user_id, action, target_type, target_id, metadata, created_at)
      VALUES (1, 'measurement.updated', 'measurement', '7', ?, ?)
    `).run(JSON.stringify({ value: 99, note: 'private legacy note' }), timestamp);
    legacy.close();

    database = await openDatabase(databasePath);
    expect(await database.prepare(`
      SELECT actor_username, metadata FROM audit_log WHERE id = 1
    `).get()).toEqual({ actor_username: 'Legacy member', metadata: null });
    expect(await database.prepare(`
      SELECT destination FROM mobile_navigation_items
      WHERE user_id = 1 ORDER BY position ASC
    `).all()).toEqual(DEFAULT_MOBILE_NAVIGATION_ITEMS.map((destination) => ({ destination })));
  });

  it('atomically links legacy workout names to one same-owner catalog exercise and remains idempotent', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'forge-workout-catalog-test-'));
    const databasePath = join(temporaryDirectory, 'forge.db');
    const legacy = new DatabaseSync(databasePath);
    const timestamp = new Date().toISOString();
    const longName = 'L'.repeat(100);
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
      CREATE TABLE exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        category TEXT NOT NULL DEFAULT 'Strength',
        unit TEXT NOT NULL DEFAULT 'kg',
        color TEXT NOT NULL DEFAULT '#f97316',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );
      CREATE TABLE workout_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        name TEXT NOT NULL,
        is_rest INTEGER NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, day_of_week)
      );
      CREATE TABLE workout_exercises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workout_day_id INTEGER NOT NULL REFERENCES workout_days(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        sets INTEGER NOT NULL,
        reps TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const insertUser = legacy.prepare(`
      INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, 'test-only-hash', 'user', 1, ?, ?)
    `);
    insertUser.run(1, 'Owner', timestamp, timestamp);
    insertUser.run(2, 'Member', timestamp, timestamp);
    const insertExercise = legacy.prepare(`
      INSERT INTO exercises (id, user_id, name, category, unit, color, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 'Strength', 'kg', '#123456', 0, ?, ?)
    `);
    insertExercise.run(10, 1, 'Bench Press', timestamp, timestamp);
    insertExercise.run(20, 2, 'Cable Fly', timestamp, timestamp);
    const insertDay = legacy.prepare(`
      INSERT INTO workout_days (
        id, user_id, day_of_week, name, is_rest, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
    `);
    insertDay.run(100, 1, 0, 'Push', timestamp, timestamp);
    insertDay.run(101, 1, 1, 'Upper', timestamp, timestamp);
    insertDay.run(200, 2, 0, 'Member push', timestamp, timestamp);
    const insertWorkoutExercise = legacy.prepare(`
      INSERT INTO workout_exercises (
        id, workout_day_id, position, name, sets, reps, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertWorkoutExercise.run(1000, 100, 0, '  bench press  ', 4, '6-8', 'keep me', timestamp, timestamp);
    insertWorkoutExercise.run(1001, 100, 1, 'Cable Fly', 3, '12', null, timestamp, timestamp);
    insertWorkoutExercise.run(1002, 101, 0, 'cable fly', 2, '15', 'same catalog link', timestamp, timestamp);
    insertWorkoutExercise.run(1003, 200, 0, 'CABLE FLY', 5, '5', 'other owner', timestamp, timestamp);
    insertWorkoutExercise.run(1004, 101, 1, longName, 1, '20', 'long legacy name', timestamp, timestamp);
    legacy.close();

    database = await openDatabase(databasePath);
    const migrated = await database.prepare(`
      SELECT we.id, wd.user_id, we.exercise_id, e.name, e.category, e.unit, e.color,
        we.position, we.sets, we.reps, we.notes, we.created_at, we.updated_at
      FROM workout_exercises we
      JOIN workout_days wd ON wd.id = we.workout_day_id
      JOIN exercises e ON e.id = we.exercise_id AND e.user_id = wd.user_id
      ORDER BY we.id ASC
    `).all() as Array<Record<string, unknown>>;
    expect(migrated).toHaveLength(5);
    expect(migrated[0]).toMatchObject({
      id: 1000,
      user_id: 1,
      exercise_id: 10,
      name: 'Bench Press',
      position: 0,
      sets: 4,
      reps: '6-8',
      notes: 'keep me',
      created_at: timestamp,
      updated_at: timestamp,
    });
    expect(migrated[1].exercise_id).toBe(migrated[2].exercise_id);
    expect(migrated[1].exercise_id).not.toBe(20);
    expect(migrated[3]).toMatchObject({ user_id: 2, exercise_id: 20, name: 'Cable Fly' });
    expect(migrated[4]).toMatchObject({ name: longName, category: 'Strength', unit: 'kg', color: '#f97316' });
    expect(await database.prepare(`
      SELECT name, category, unit, color, sort_order FROM exercises
      WHERE user_id = 1 ORDER BY sort_order ASC, id ASC
    `).all()).toEqual([
      { name: 'Bench Press', category: 'Strength', unit: 'kg', color: '#123456', sort_order: 0 },
      { name: 'Cable Fly', category: 'Strength', unit: 'kg', color: '#f97316', sort_order: 1 },
      { name: longName, category: 'Strength', unit: 'kg', color: '#f97316', sort_order: 2 },
    ]);
    const columns = await database.prepare('PRAGMA table_info(workout_exercises)').all();
    expect(columns).toContainEqual(expect.objectContaining({ name: 'exercise_id', notnull: 1 }));
    expect(columns).not.toContainEqual(expect.objectContaining({ name: 'name' }));
    expect(await database.prepare('PRAGMA foreign_key_list(workout_exercises)').all()).toContainEqual(
      expect.objectContaining({ table: 'exercises', from: 'exercise_id', to: 'id', on_delete: 'RESTRICT' }),
    );
    expect(await database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(await database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_workout_exercises_exercise'
    `).get()).toEqual({ name: 'idx_workout_exercises_exercise' });

    const exerciseIdsBeforeRestart = migrated.map((row) => row.exercise_id);
    await database.close();
    database = undefined;
    database = await openDatabase(databasePath);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM workout_exercises').get()).toEqual({ count: 5 });
    expect(await database.prepare('SELECT COUNT(*) AS count FROM exercises WHERE user_id = 1').get()).toEqual({ count: 3 });
    expect((await database.prepare(`
      SELECT exercise_id FROM workout_exercises ORDER BY id ASC
    `).all()).map((row) => row.exercise_id)).toEqual(exerciseIdsBeforeRestart);
  });

});
