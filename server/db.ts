import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createClient,
  type Client,
  type InValue,
  type ResultSet,
} from '@libsql/client';

interface SqlExecutor {
  execute(statement: { sql: string; args: InValue[] }): Promise<ResultSet>;
  executeMultiple(sql: string): Promise<void>;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: bigint | undefined;
}

export interface Statement {
  all(...args: InValue[]): Promise<Array<Record<string, unknown>>>;
  get(...args: InValue[]): Promise<Record<string, unknown> | undefined>;
  run(...args: InValue[]): Promise<RunResult>;
}

function plainRows(result: ResultSet): Array<Record<string, unknown>> {
  return result.rows.map((row) => Object.fromEntries(
    result.columns.map((column, index) => [column, row[index]]),
  ));
}

export class Database {
  private readonly transactionContext = new AsyncLocalStorage<SqlExecutor>();
  private localOperationTail = Promise.resolve();

  constructor(private readonly client: Client) {}

  private async withLocalOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.client.protocol !== 'file' || this.transactionContext.getStore()) {
      return operation();
    }

    const previous = this.localOperationTail;
    let release!: () => void;
    this.localOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  prepare(sql: string): Statement {
    const execute = async (args: InValue[]): Promise<ResultSet> => {
      const executor = this.transactionContext.getStore() ?? this.client;
      return this.withLocalOperation(() => executor.execute({ sql, args }));
    };

    return {
      all: async (...args) => plainRows(await execute(args)),
      get: async (...args) => plainRows(await execute(args))[0],
      run: async (...args) => {
        const result = await execute(args);
        return {
          changes: result.rowsAffected,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    const executor = this.transactionContext.getStore() ?? this.client;
    await this.withLocalOperation(() => executor.executeMultiple(sql));
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const activeTransaction = this.transactionContext.getStore();
    if (activeTransaction) return operation();

    // Keep local and in-memory work on the client's owned connection. The
    // local-operation queue prevents another request from entering that
    // connection while this explicit transaction is active.
    if (this.client.protocol === 'file') {
      return this.withLocalOperation(async () => {
        await this.client.execute('BEGIN IMMEDIATE');
        try {
          const result = await this.transactionContext.run(this.client, operation);
          await this.client.execute('COMMIT');
          return result;
        } catch (error) {
          try {
            await this.client.execute('ROLLBACK');
          } catch {
            // Preserve the operation/commit failure if the driver has already
            // closed the transaction.
          }
          throw error;
        }
      });
    }

    const transaction = await this.client.transaction('write');
    try {
      const result = await this.transactionContext.run(transaction, operation);
      await transaction.commit();
      return result;
    } catch (error) {
      if (!transaction.closed) {
        try {
          await transaction.rollback();
        } catch {
          // Preserve the original operation/commit failure.
        }
      }
      throw error;
    } finally {
      if (!transaction.closed) transaction.close();
    }
  }

  close(): void {
    this.transactionContext.disable();
    this.client.close();
  }
}

export interface OpenDatabaseOptions {
  url?: string;
  authToken?: string;
  path?: string;
}

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

export const MOBILE_NAVIGATION_DESTINATIONS = [
  'dashboard',
  'measurements',
  'lifts',
  'workout',
  'meals',
  'sharing',
  'admin',
] as const;

export type MobileNavigationDestination = typeof MOBILE_NAVIGATION_DESTINATIONS[number];

export const DEFAULT_MOBILE_NAVIGATION_ITEMS = [
  'dashboard',
  'measurements',
  'lifts',
  'workout',
] as const satisfies readonly MobileNavigationDestination[];

function localDatabaseUrl(databasePath: string): string {
  if (databasePath === ':memory:') return ':memory:';

  const absolutePath = resolve(databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  return pathToFileURL(absolutePath).href;
}

function normalizeOpenOptions(options: string | OpenDatabaseOptions): Required<Pick<OpenDatabaseOptions, 'url'>> & OpenDatabaseOptions {
  if (typeof options === 'string') return { url: localDatabaseUrl(options), path: options };
  if (options.url) return { ...options, url: options.url };
  const path = options.path ?? './data/forge.db';
  return { ...options, path, url: localDatabaseUrl(path) };
}

export async function openDatabase(
  options: string | OpenDatabaseOptions = { path: './data/forge.db' },
): Promise<Database> {
  const { url, authToken } = normalizeOpenOptions(options);
  const isRemote = !url.startsWith('file:') && url !== ':memory:';
  if (isRemote && !authToken) {
    throw new Error('TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL points to a remote database');
  }

  const database = new Database(createClient({
    url,
    ...(authToken ? { authToken } : {}),
    intMode: 'number',
    timeout: 5_000,
  }));
  await initializeDatabase(database);
  return database;
}

export async function initializeDatabase(database: Database): Promise<void> {
  await database.exec(`
    PRAGMA foreign_keys = ON;

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

    CREATE TABLE IF NOT EXISTS mobile_navigation_items (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
      destination TEXT NOT NULL CHECK (
        destination IN ('dashboard', 'measurements', 'lifts', 'workout', 'meals', 'sharing', 'admin')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, position),
      UNIQUE (user_id, destination)
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
      exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS bmr_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      age INTEGER NOT NULL CHECK (age BETWEEN 18 AND 120),
      sex TEXT NOT NULL CHECK (sex IN ('female', 'male')),
      height_feet INTEGER NOT NULL CHECK (height_feet BETWEEN 3 AND 9),
      height_inches REAL NOT NULL CHECK (height_inches >= 0 AND height_inches < 12),
      weight_source TEXT NOT NULL CHECK (weight_source IN ('manual', 'measurement')),
      weight_value REAL NOT NULL CHECK (weight_value > 0),
      weight_unit TEXT NOT NULL CHECK (weight_unit IN ('kg', 'lb', 'st')),
      body_part_id INTEGER,
      measurement_id INTEGER,
      source_name TEXT,
      source_recorded_at TEXT,
      estimated_bmr INTEGER NOT NULL CHECK (estimated_bmr > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((((height_feet * 12) + height_inches) * 2.54) BETWEEN 100 AND 275),
      CHECK (
        (weight_unit = 'kg' AND weight_value BETWEEN 20 AND 500)
        OR (weight_unit = 'lb' AND (weight_value * 0.45359237) BETWEEN 20 AND 500)
        OR (weight_unit = 'st' AND (weight_value * 6.35029318) BETWEEN 20 AND 500)
      ),
      CHECK (
        (weight_source = 'manual'
          AND body_part_id IS NULL
          AND measurement_id IS NULL
          AND source_name IS NULL
          AND source_recorded_at IS NULL)
        OR
        (weight_source = 'measurement'
          AND body_part_id IS NOT NULL
          AND measurement_id IS NOT NULL
          AND source_name IS NOT NULL
          AND source_recorded_at IS NOT NULL)
      )
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

  // Keep every legacy table inspection, alteration, and backfill in one write
  // transaction. This prevents concurrent app starts from observing and acting
  // on the same partially migrated schema.
  await database.transaction(async () => {
    const userColumns = await database.prepare('PRAGMA table_info(users)').all() as unknown as Array<{ name: string }>;
    if (!userColumns.some((column) => column.name === 'requires_password_setup')) {
      await database.prepare(`
        ALTER TABLE users ADD COLUMN requires_password_setup INTEGER NOT NULL DEFAULT 0
          CHECK (requires_password_setup IN (0, 1))
      `).run();
    }
    if (!userColumns.some((column) => column.name === 'invite_code_hash')) {
      await database.prepare('ALTER TABLE users ADD COLUMN invite_code_hash TEXT').run();
    }
    await database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code
        ON users(invite_code_hash) WHERE invite_code_hash IS NOT NULL
    `).run();
  });

  // Preserve the alphabetical order older releases displayed, then let each user
  // explicitly control it from this point onward. This migration only runs when
  // the column is first added, so subsequent starts never overwrite user choices.
  await database.transaction(async () => {
    const bodyPartColumns = await database.prepare('PRAGMA table_info(body_parts)').all() as unknown as Array<{ name: string }>;
    if (!bodyPartColumns.some((column) => column.name === 'sort_order')) {
      await database.prepare(`
        ALTER TABLE body_parts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
          CHECK (sort_order >= 0)
      `).run();
      await database.prepare(`
        WITH ranked AS (
          SELECT id,
            ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY name COLLATE NOCASE, id ASC) - 1 AS position
          FROM body_parts
        )
        UPDATE body_parts
        SET sort_order = (SELECT position FROM ranked WHERE ranked.id = body_parts.id)
      `).run();
    }
  });

  await database.transaction(async () => {
    const exerciseColumns = await database.prepare('PRAGMA table_info(exercises)').all() as unknown as Array<{ name: string }>;
    if (!exerciseColumns.some((column) => column.name === 'sort_order')) {
      await database.prepare(`
        ALTER TABLE exercises ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
          CHECK (sort_order >= 0)
      `).run();
      await database.prepare(`
        WITH ranked AS (
          SELECT id,
            ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY name COLLATE NOCASE, id ASC) - 1 AS position
          FROM exercises
        )
        UPDATE exercises
        SET sort_order = (SELECT position FROM ranked WHERE ranked.id = exercises.id)
      `).run();
    }
  });

  await migrateWorkoutExerciseCatalogLinks(database);

  // Existing installations created before actor snapshots need a safe additive migration.
  await database.transaction(async () => {
    const auditColumns = await database.prepare('PRAGMA table_info(audit_log)').all() as unknown as Array<{ name: string }>;
    if (!auditColumns.some((column) => column.name === 'actor_username')) {
      await database.prepare('ALTER TABLE audit_log ADD COLUMN actor_username TEXT').run();
    }

    await database.prepare(`
      UPDATE audit_log
      SET actor_username = (
        SELECT users.username FROM users WHERE users.id = audit_log.actor_user_id
      )
      WHERE actor_username IS NULL AND actor_user_id IS NOT NULL
    `).run();
    await database.prepare(`
      UPDATE audit_log
      SET metadata = NULL
      WHERE target_type IN ('body_part', 'measurement', 'exercise', 'lift', 'workout_day', 'meal', 'meal_plan')
        AND metadata IS NOT NULL
    `).run();
  });

  const users = await database.prepare('SELECT id, role FROM users').all() as unknown as Array<{ id: number; role: string }>;
  for (const user of users) {
    const userId = Number(user.id);
    await seedUserPlans(database, userId);
    await seedUserMobileNavigation(database, userId);
    await readUserMobileNavigation(database, userId, user.role === 'admin');
  }
}

async function migrateWorkoutExerciseCatalogLinks(database: Database): Promise<void> {
  await database.transaction(async () => {
    const columns = await database.prepare('PRAGMA table_info(workout_exercises)')
      .all() as unknown as Array<{ name: string; notnull: number }>;
    const foreignKeys = await database.prepare('PRAGMA foreign_key_list(workout_exercises)')
      .all() as unknown as Array<{ table: string; from: string; to: string; on_delete: string }>;
    const exerciseIdColumn = columns.find((column) => column.name === 'exercise_id');
    const hasLegacyName = columns.some((column) => column.name === 'name');
    const hasRequiredExerciseForeignKey = foreignKeys.some((foreignKey) => (
      foreignKey.table === 'exercises'
      && foreignKey.from === 'exercise_id'
      && foreignKey.to === 'id'
      && foreignKey.on_delete === 'RESTRICT'
    ));
    if (exerciseIdColumn?.notnull === 1 && !hasLegacyName && hasRequiredExerciseForeignKey) {
      await database.prepare(`
        CREATE INDEX IF NOT EXISTS idx_workout_exercises_exercise
          ON workout_exercises(exercise_id)
      `).run();
      return;
    }

    if (hasLegacyName) {
      const invalidName = await database.prepare(`
        SELECT id FROM workout_exercises
        WHERE LENGTH(TRIM(name)) = 0 OR LENGTH(TRIM(name)) > 100
        LIMIT 1
      `).get() as unknown as { id: number } | undefined;
      if (invalidName) {
        throw new Error(`Legacy workout exercise ${invalidName.id} has an invalid name`);
      }

      const unmatchedNames = await database.prepare(`
        WITH legacy_names AS (
          SELECT wd.user_id, MIN(we.id) AS first_workout_exercise_id
          FROM workout_exercises we
          JOIN workout_days wd ON wd.id = we.workout_day_id
          GROUP BY wd.user_id, TRIM(we.name) COLLATE NOCASE
        )
        SELECT legacy_names.user_id, TRIM(we.name) AS name
        FROM legacy_names
        JOIN workout_exercises we ON we.id = legacy_names.first_workout_exercise_id
        LEFT JOIN exercises e
          ON e.user_id = legacy_names.user_id
         AND TRIM(e.name) = TRIM(we.name) COLLATE NOCASE
        WHERE e.id IS NULL
        ORDER BY legacy_names.user_id ASC, legacy_names.first_workout_exercise_id ASC
      `).all() as unknown as Array<{ user_id: number; name: string }>;
      const timestamp = new Date().toISOString();
      const insertExercise = database.prepare(`
        INSERT OR IGNORE INTO exercises (
          user_id, name, category, unit, color, sort_order, created_at, updated_at
        )
        SELECT users.id, ?, 'Strength', 'kg', '#f97316',
          (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM exercises WHERE user_id = users.id),
          ?, ?
        FROM users WHERE users.id = ?
      `);
      for (const legacy of unmatchedNames) {
        const result = await insertExercise.run(
          legacy.name,
          timestamp,
          timestamp,
          Number(legacy.user_id),
        );
        if (result.changes !== 1) {
          const matched = await database.prepare(`
            SELECT id FROM exercises
            WHERE user_id = ? AND TRIM(name) = ? COLLATE NOCASE
          `).get(Number(legacy.user_id), legacy.name);
          if (!matched) throw new Error('Legacy workout exercise could not be added to its owner catalog');
        }
      }
    }

    await database.prepare('DROP TABLE IF EXISTS workout_exercises_catalog_migration').run();
    await database.prepare(`
      CREATE TABLE workout_exercises_catalog_migration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workout_day_id INTEGER NOT NULL REFERENCES workout_days(id) ON DELETE CASCADE,
        exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL DEFAULT 0,
        sets INTEGER NOT NULL CHECK (sets > 0),
        reps TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run();
    if (hasLegacyName) {
      await database.prepare(`
        INSERT INTO workout_exercises_catalog_migration (
          id, workout_day_id, exercise_id, position, sets, reps, notes, created_at, updated_at
        )
        SELECT we.id, we.workout_day_id, e.id, we.position, we.sets, we.reps,
          we.notes, we.created_at, we.updated_at
        FROM workout_exercises we
        JOIN workout_days wd ON wd.id = we.workout_day_id
        JOIN exercises e ON e.id = (
          SELECT MIN(matched.id)
          FROM exercises matched
          WHERE matched.user_id = wd.user_id
            AND TRIM(matched.name) = TRIM(we.name) COLLATE NOCASE
        )
      `).run();
    } else if (exerciseIdColumn) {
      await database.prepare(`
        INSERT INTO workout_exercises_catalog_migration (
          id, workout_day_id, exercise_id, position, sets, reps, notes, created_at, updated_at
        )
        SELECT we.id, we.workout_day_id, we.exercise_id, we.position, we.sets, we.reps,
          we.notes, we.created_at, we.updated_at
        FROM workout_exercises we
        JOIN workout_days wd ON wd.id = we.workout_day_id
        JOIN exercises e ON e.id = we.exercise_id AND e.user_id = wd.user_id
      `).run();
    } else {
      throw new Error('Workout exercise schema has neither a legacy name nor an exercise link');
    }

    const sourceCount = await database.prepare('SELECT COUNT(*) AS count FROM workout_exercises')
      .get() as unknown as { count: number };
    const migratedCount = await database.prepare('SELECT COUNT(*) AS count FROM workout_exercises_catalog_migration')
      .get() as unknown as { count: number };
    if (Number(sourceCount.count) !== Number(migratedCount.count)) {
      throw new Error('Legacy workout exercise migration did not preserve every row');
    }
    const ownershipMismatch = await database.prepare(`
      SELECT migrated.id
      FROM workout_exercises_catalog_migration migrated
      JOIN workout_days wd ON wd.id = migrated.workout_day_id
      JOIN exercises e ON e.id = migrated.exercise_id
      WHERE wd.user_id != e.user_id
      LIMIT 1
    `).get();
    if (ownershipMismatch) throw new Error('Legacy workout exercise migration found a cross-user link');
    const foreignKeyFailure = await database.prepare(`
      PRAGMA foreign_key_check(workout_exercises_catalog_migration)
    `).get();
    if (foreignKeyFailure) throw new Error('Legacy workout exercise migration failed its foreign-key check');

    await database.prepare('DROP TABLE workout_exercises').run();
    await database.prepare(`
      ALTER TABLE workout_exercises_catalog_migration RENAME TO workout_exercises
    `).run();
    await database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_workout_exercises_day
        ON workout_exercises(workout_day_id, position)
    `).run();
    await database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_workout_exercises_exercise
        ON workout_exercises(exercise_id)
    `).run();
  });
}

export async function seedUserDefaults(database: Database, userId: number): Promise<void> {
  const now = new Date().toISOString();
  const bodyPartPlaceholders = DEFAULT_BODY_PARTS.map(() => '(?, ?, ?, ?)').join(', ');
  const bodyPartArgs = DEFAULT_BODY_PARTS.flatMap(([name, unit, color], sortOrder) => [
    name, unit, color, sortOrder,
  ]);
  await database.prepare(`
    WITH desired(name, unit, color, sort_order) AS (VALUES ${bodyPartPlaceholders})
    INSERT OR IGNORE INTO body_parts (user_id, name, unit, color, sort_order, created_at, updated_at)
    SELECT users.id, desired.name, desired.unit, desired.color, desired.sort_order, ?, ?
    FROM users CROSS JOIN desired WHERE users.id = ?
  `).run(...bodyPartArgs, now, now, userId);

  const exercisePlaceholders = DEFAULT_EXERCISES.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const exerciseArgs = DEFAULT_EXERCISES.flatMap(([name, category, unit, color], sortOrder) => [
    name, category, unit, color, sortOrder,
  ]);
  await database.prepare(`
    WITH desired(name, category, unit, color, sort_order) AS (VALUES ${exercisePlaceholders})
    INSERT OR IGNORE INTO exercises (user_id, name, category, unit, color, sort_order, created_at, updated_at)
    SELECT users.id, desired.name, desired.category, desired.unit, desired.color,
      desired.sort_order, ?, ?
    FROM users CROSS JOIN desired WHERE users.id = ?
  `).run(...exerciseArgs, now, now, userId);

  await seedUserPlans(database, userId);
  await seedUserMobileNavigation(database, userId);
}

export async function seedUserPlans(database: Database, userId: number): Promise<void> {
  const timestamp = new Date().toISOString();
  await database.prepare(`
    WITH desired(day_of_week) AS (VALUES (0), (1), (2), (3), (4), (5), (6))
    INSERT OR IGNORE INTO workout_days (
      user_id, day_of_week, name, is_rest, notes, created_at, updated_at
    )
    SELECT users.id, desired.day_of_week, 'Rest day', 1, NULL, ?, ?
    FROM users CROSS JOIN desired WHERE users.id = ?
  `).run(timestamp, timestamp, userId);
  await database.prepare(`
    INSERT OR IGNORE INTO meal_plan_settings (
      user_id, show_calories, show_macros, created_at, updated_at
    )
    SELECT id, 1, 1, ?, ? FROM users WHERE id = ?
  `).run(timestamp, timestamp, userId);
}

interface MobileNavigationRow {
  position: number;
  destination: string;
}

function validMobileNavigation(
  rows: MobileNavigationRow[],
  allowAdmin: boolean,
): rows is Array<{ position: number; destination: MobileNavigationDestination }> {
  if (rows.length !== DEFAULT_MOBILE_NAVIGATION_ITEMS.length) return false;
  const destinations = new Set<string>();
  return rows.every((row, position) => {
    if (Number(row.position) !== position) return false;
    if (!MOBILE_NAVIGATION_DESTINATIONS.includes(row.destination as MobileNavigationDestination)) return false;
    if (!allowAdmin && row.destination === 'admin') return false;
    if (destinations.has(row.destination)) return false;
    destinations.add(row.destination);
    return true;
  });
}

async function mobileNavigationRows(database: Database, userId: number): Promise<MobileNavigationRow[]> {
  return database.prepare(`
    SELECT position, destination
    FROM mobile_navigation_items
    WHERE user_id = ?
    ORDER BY position ASC
  `).all(userId) as unknown as MobileNavigationRow[];
}

export async function seedUserMobileNavigation(database: Database, userId: number): Promise<void> {
  const timestamp = new Date().toISOString();
  const values = DEFAULT_MOBILE_NAVIGATION_ITEMS.map(() => '(?, ?)').join(', ');
  const args = DEFAULT_MOBILE_NAVIGATION_ITEMS.flatMap((destination, position) => [position, destination]);
  await database.prepare(`
    WITH desired(position, destination) AS (VALUES ${values})
    INSERT OR IGNORE INTO mobile_navigation_items (
      user_id, position, destination, created_at, updated_at
    )
    SELECT users.id, desired.position, desired.destination, ?, ?
    FROM users CROSS JOIN desired
    WHERE users.id = ?
  `).run(...args, timestamp, timestamp, userId);
}

export async function replaceUserMobileNavigation(
  database: Database,
  userId: number,
  items: readonly MobileNavigationDestination[],
): Promise<MobileNavigationDestination[]> {
  const rows = items.map((destination, position) => ({ position, destination }));
  if (!validMobileNavigation(rows, true)) {
    throw new Error('Mobile navigation must contain four unique supported destinations');
  }

  await database.transaction(async () => {
    await database.prepare('DELETE FROM mobile_navigation_items WHERE user_id = ?').run(userId);
    const timestamp = new Date().toISOString();
    const insert = database.prepare(`
      INSERT INTO mobile_navigation_items (
        user_id, position, destination, created_at, updated_at
      )
      SELECT id, ?, ?, ?, ? FROM users WHERE id = ?
    `);
    for (const [position, destination] of items.entries()) {
      const result = await insert.run(position, destination, timestamp, timestamp, userId);
      if (result.changes !== 1) throw new Error('Mobile navigation owner is unavailable');
    }
  });
  return [...items];
}

export async function readUserMobileNavigation(
  database: Database,
  userId: number,
  allowAdmin: boolean,
): Promise<MobileNavigationDestination[]> {
  const rows = await mobileNavigationRows(database, userId);
  if (validMobileNavigation(rows, allowAdmin)) return rows.map((row) => row.destination);

  return database.transaction(async () => {
    const latestRows = await mobileNavigationRows(database, userId);
    if (validMobileNavigation(latestRows, allowAdmin)) return latestRows.map((row) => row.destination);
    return replaceUserMobileNavigation(database, userId, DEFAULT_MOBILE_NAVIGATION_ITEMS);
  });
}

export interface AuditEntryInput {
  actorUserId?: number | null;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  metadata?: unknown;
  ipAddress?: string | null;
}

export async function writeAudit(database: Database, entry: AuditEntryInput): Promise<void> {
  const actorUserId = entry.actorUserId ?? null;
  await database.prepare(`
    INSERT INTO audit_log (
      actor_user_id, actor_username, action, target_type, target_id, metadata, ip_address, created_at
    ) VALUES (
      (SELECT id FROM users WHERE id = ?),
      (SELECT username FROM users WHERE id = ?),
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    actorUserId,
    actorUserId,
    entry.action,
    entry.targetType,
    entry.targetId == null ? null : String(entry.targetId),
    entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
    entry.ipAddress ?? null,
    new Date().toISOString(),
  );
}

export function runTransaction<T>(database: Database, operation: () => Promise<T>): Promise<T> {
  return database.transaction(operation);
}
