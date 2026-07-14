import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

const DEFAULT_BODY_PARTS = [
  ['Body Weight', 'kg', '#f97316'],
  ['Chest', 'cm', '#ef4444'],
  ['Waist', 'cm', '#eab308'],
  ['Hips', 'cm', '#22c55e'],
  ['Left Arm', 'cm', '#3b82f6'],
  ['Right Arm', 'cm', '#6366f1'],
  ['Left Thigh', 'cm', '#8b5cf6'],
  ['Right Thigh', 'cm', '#d946ef'],
  ['Neck', 'cm', '#14b8a6'],
] as const;

const DEFAULT_EXERCISES = [
  ['Bench Press', 'Chest', 'kg', '#f97316'],
  ['Back Squat', 'Legs', 'kg', '#22c55e'],
  ['Deadlift', 'Back', 'kg', '#3b82f6'],
  ['Overhead Press', 'Shoulders', 'kg', '#8b5cf6'],
  ['Barbell Row', 'Back', 'kg', '#ef4444'],
] as const;

export function openDatabase(databasePath = './data/forge.db'): Database {
  if (databasePath !== ':memory:') {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    databasePath = absolutePath;
  }

  const database = new DatabaseSync(databasePath);
  initializeDatabase(database);
  return database;
}

export function initializeDatabase(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      requires_password_setup INTEGER NOT NULL DEFAULT 0 CHECK (requires_password_setup IN (0, 1)),
      invite_code_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS body_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      unit TEXT NOT NULL DEFAULT 'cm',
      color TEXT NOT NULL DEFAULT '#f97316',
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, name)
    );

    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body_part_id INTEGER NOT NULL REFERENCES body_parts(id) ON DELETE CASCADE,
      value REAL NOT NULL CHECK (value > 0),
      recorded_at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      category TEXT NOT NULL DEFAULT 'Strength',
      unit TEXT NOT NULL DEFAULT 'kg',
      color TEXT NOT NULL DEFAULT '#f97316',
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, name)
    );

    CREATE TABLE IF NOT EXISTS lift_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      weight REAL NOT NULL CHECK (weight > 0),
      reps INTEGER NOT NULL DEFAULT 1 CHECK (reps > 0),
      recorded_at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_username TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      metadata TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sharing_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      viewer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      can_view_measurements INTEGER NOT NULL DEFAULT 0 CHECK (can_view_measurements IN (0, 1)),
      can_view_lifts INTEGER NOT NULL DEFAULT 0 CHECK (can_view_lifts IN (0, 1)),
      can_view_workout INTEGER NOT NULL DEFAULT 0 CHECK (can_view_workout IN (0, 1)),
      can_view_meals INTEGER NOT NULL DEFAULT 0 CHECK (can_view_meals IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (owner_user_id != viewer_user_id),
      UNIQUE (owner_user_id, viewer_user_id)
    );

    CREATE TABLE IF NOT EXISTS workout_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      name TEXT NOT NULL DEFAULT 'Rest day',
      is_rest INTEGER NOT NULL DEFAULT 1 CHECK (is_rest IN (0, 1)),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS workout_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_day_id INTEGER NOT NULL REFERENCES workout_days(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      sets INTEGER NOT NULL CHECK (sets > 0),
      reps TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meal_plan_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      show_calories INTEGER NOT NULL DEFAULT 1 CHECK (show_calories IN (0, 1)),
      show_macros INTEGER NOT NULL DEFAULT 1 CHECK (show_macros IN (0, 1)),
      calorie_target REAL,
      protein_target REAL,
      carbs_target REAL,
      fat_target REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (calorie_target IS NULL OR calorie_target >= 0),
      CHECK (protein_target IS NULL OR protein_target >= 0),
      CHECK (carbs_target IS NULL OR carbs_target >= 0),
      CHECK (fat_target IS NULL OR fat_target >= 0)
    );

    CREATE TABLE IF NOT EXISTS meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      name TEXT NOT NULL,
      description TEXT,
      calories REAL CHECK (calories IS NULL OR calories >= 0),
      protein REAL CHECK (protein IS NULL OR protein >= 0),
      carbs REAL CHECK (carbs IS NULL OR carbs >= 0),
      fat REAL CHECK (fat IS NULL OR fat >= 0),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_body_parts_user ON body_parts(user_id);
    CREATE INDEX IF NOT EXISTS idx_measurements_part_date ON measurements(body_part_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_exercises_user ON exercises(user_id);
    CREATE INDEX IF NOT EXISTS idx_lifts_exercise_date ON lift_records(exercise_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sharing_owner ON sharing_permissions(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_sharing_viewer ON sharing_permissions(viewer_user_id);
    CREATE INDEX IF NOT EXISTS idx_workout_days_user ON workout_days(user_id, day_of_week);
    CREATE INDEX IF NOT EXISTS idx_workout_exercises_day ON workout_exercises(workout_day_id, position);
    CREATE INDEX IF NOT EXISTS idx_meals_user_day ON meals(user_id, day_of_week);
  `);

  const userColumns = database.prepare('PRAGMA table_info(users)').all() as unknown as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === 'requires_password_setup')) {
    database.exec(`
      ALTER TABLE users ADD COLUMN requires_password_setup INTEGER NOT NULL DEFAULT 0
        CHECK (requires_password_setup IN (0, 1))
    `);
  }
  if (!userColumns.some((column) => column.name === 'invite_code_hash')) {
    database.exec('ALTER TABLE users ADD COLUMN invite_code_hash TEXT');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code
      ON users(invite_code_hash) WHERE invite_code_hash IS NOT NULL
  `);

  // Preserve the alphabetical order older releases displayed, then let each user
  // explicitly control it from this point onward. This migration only runs when
  // the column is first added, so subsequent starts never overwrite user choices.
  const bodyPartColumns = database.prepare('PRAGMA table_info(body_parts)').all() as unknown as Array<{ name: string }>;
  if (!bodyPartColumns.some((column) => column.name === 'sort_order')) {
    database.exec(`
      ALTER TABLE body_parts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
        CHECK (sort_order >= 0);
      WITH ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY name COLLATE NOCASE, id ASC) - 1 AS position
        FROM body_parts
      )
      UPDATE body_parts
      SET sort_order = (SELECT position FROM ranked WHERE ranked.id = body_parts.id);
    `);
  }

  const exerciseColumns = database.prepare('PRAGMA table_info(exercises)').all() as unknown as Array<{ name: string }>;
  if (!exerciseColumns.some((column) => column.name === 'sort_order')) {
    database.exec(`
      ALTER TABLE exercises ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
        CHECK (sort_order >= 0);
      WITH ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY name COLLATE NOCASE, id ASC) - 1 AS position
        FROM exercises
      )
      UPDATE exercises
      SET sort_order = (SELECT position FROM ranked WHERE ranked.id = exercises.id);
    `);
  }

  // Existing installations created before actor snapshots need a safe additive migration.
  const auditColumns = database.prepare('PRAGMA table_info(audit_log)').all() as unknown as Array<{ name: string }>;
  if (!auditColumns.some((column) => column.name === 'actor_username')) {
    database.exec('ALTER TABLE audit_log ADD COLUMN actor_username TEXT');
  }

  database.exec(`
    UPDATE audit_log
    SET actor_username = (
      SELECT users.username FROM users WHERE users.id = audit_log.actor_user_id
    )
    WHERE actor_username IS NULL AND actor_user_id IS NOT NULL;

    UPDATE audit_log
    SET metadata = NULL
    WHERE target_type IN ('body_part', 'measurement', 'exercise', 'lift', 'workout_day', 'meal', 'meal_plan')
      AND metadata IS NOT NULL;
  `);

  const users = database.prepare('SELECT id FROM users').all() as unknown as Array<{ id: number }>;
  for (const user of users) seedUserPlans(database, Number(user.id));
}

export function seedUserDefaults(database: Database, userId: number): void {
  const now = new Date().toISOString();
  const insertBodyPart = database.prepare(`
    INSERT OR IGNORE INTO body_parts (user_id, name, unit, color, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertExercise = database.prepare(`
    INSERT OR IGNORE INTO exercises (user_id, name, category, unit, color, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [sortOrder, [name, unit, color]] of DEFAULT_BODY_PARTS.entries()) {
    insertBodyPart.run(userId, name, unit, color, sortOrder, now, now);
  }
  for (const [sortOrder, [name, category, unit, color]] of DEFAULT_EXERCISES.entries()) {
    insertExercise.run(userId, name, category, unit, color, sortOrder, now, now);
  }
  seedUserPlans(database, userId);
}

export function seedUserPlans(database: Database, userId: number): void {
  const timestamp = new Date().toISOString();
  const insertDay = database.prepare(`
    INSERT OR IGNORE INTO workout_days (
      user_id, day_of_week, name, is_rest, notes, created_at, updated_at
    ) VALUES (?, ?, 'Rest day', 1, NULL, ?, ?)
  `);
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    insertDay.run(userId, dayOfWeek, timestamp, timestamp);
  }
  database.prepare(`
    INSERT OR IGNORE INTO meal_plan_settings (
      user_id, show_calories, show_macros, created_at, updated_at
    ) VALUES (?, 1, 1, ?, ?)
  `).run(userId, timestamp, timestamp);
}

export interface AuditEntryInput {
  actorUserId?: number | null;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  metadata?: unknown;
  ipAddress?: string | null;
}

export function writeAudit(database: Database, entry: AuditEntryInput): void {
  const actorUserId = entry.actorUserId ?? null;
  const actor = actorUserId == null
    ? undefined
    : database.prepare('SELECT username FROM users WHERE id = ?').get(actorUserId) as unknown as { username: string } | undefined;
  database.prepare(`
    INSERT INTO audit_log (
      actor_user_id, actor_username, action, target_type, target_id, metadata, ip_address, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorUserId,
    actor?.username ?? null,
    entry.action,
    entry.targetType,
    entry.targetId == null ? null : String(entry.targetId),
    entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
    entry.ipAddress ?? null,
    new Date().toISOString(),
  );
}

export function runTransaction<T>(database: Database, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
