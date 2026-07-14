import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openDatabase,
  runTransaction,
  seedUserDefaults,
  type Database,
} from '../server/db.js';

let database: Database | undefined;
let temporaryDirectory: string | undefined;

function openTemporaryDatabase(): Database {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'forge-test-'));
  database = openDatabase(join(temporaryDirectory, 'forge.db'));
  return database;
}

function insertUser(db: Database, username: string, role: 'user' | 'admin' = 'user'): number {
  const now = new Date().toISOString();
  return Number(
    db.prepare(`
      INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(username, 'test-only-hash', role, now, now).lastInsertRowid,
  );
}

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('database initialization', () => {
  it('creates an isolated SQLite database and enables foreign-key enforcement', () => {
    const db = openTemporaryDatabase();

    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get())
      .toEqual({ name: 'users' });
  });

  it('seeds each user with their own defaults and remains idempotent', () => {
    const db = openTemporaryDatabase();
    const ownerId = insertUser(db, 'Owner');
    const memberId = insertUser(db, 'Member');

    seedUserDefaults(db, ownerId);
    seedUserDefaults(db, ownerId);
    seedUserDefaults(db, memberId);

    const counts = db.prepare(`
      SELECT user_id, COUNT(*) AS count
      FROM body_parts
      GROUP BY user_id
      ORDER BY user_id
    `).all();
    expect(counts).toEqual([
      { user_id: ownerId, count: 9 },
      { user_id: memberId, count: 9 },
    ]);

    const ownerBench = db.prepare(
      "SELECT id FROM exercises WHERE user_id = ? AND name = 'Bench Press'",
    ).get(ownerId);
    const memberBench = db.prepare(
      "SELECT id FROM exercises WHERE user_id = ? AND name = 'Bench Press'",
    ).get(memberId);
    expect(ownerBench).toBeTruthy();
    expect(memberBench).toBeTruthy();
    expect(ownerBench).not.toEqual(memberBench);
  });

  it('rolls back every statement when a transaction fails', () => {
    const db = openTemporaryDatabase();

    expect(() => runTransaction(db, () => {
      insertUser(db, 'Should Roll Back');
      throw new Error('stop');
    })).toThrow('stop');

    expect(db.prepare("SELECT id FROM users WHERE username = 'Should Roll Back'").get())
      .toBeUndefined();
  });

  it('cascades a deleted user through their private measurement and lift data', () => {
    const db = openTemporaryDatabase();
    const userId = insertUser(db, 'Disposable');
    seedUserDefaults(db, userId);
    const now = new Date().toISOString();
    const bodyPart = db.prepare('SELECT id FROM body_parts WHERE user_id = ? LIMIT 1').get(userId) as { id: number };
    const exercise = db.prepare('SELECT id FROM exercises WHERE user_id = ? LIMIT 1').get(userId) as { id: number };

    db.prepare(`
      INSERT INTO measurements (body_part_id, value, recorded_at, created_at, updated_at)
      VALUES (?, 80, ?, ?, ?)
    `).run(bodyPart.id, now, now, now);
    db.prepare(`
      INSERT INTO lift_records (exercise_id, weight, reps, recorded_at, created_at, updated_at)
      VALUES (?, 100, 1, ?, ?, ?)
    `).run(exercise.id, now, now, now);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    expect(db.prepare('SELECT COUNT(*) AS count FROM measurements').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM lift_records').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM body_parts').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM exercises').get()).toEqual({ count: 0 });
  });

  it('migrates legacy audit logs, snapshots actors, and scrubs private training metadata', () => {
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

    database = openDatabase(databasePath);
    expect(database.prepare(`
      SELECT actor_username, metadata FROM audit_log WHERE id = 1
    `).get()).toEqual({ actor_username: 'Legacy member', metadata: null });
  });

});
