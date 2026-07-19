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

});
