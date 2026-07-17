import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError, z } from 'zod';
import {
  initializeDatabase,
  openDatabase,
  runTransaction,
  seedUserDefaults,
  seedUserPlans,
  writeAudit,
  type Database,
} from './db.js';
import {
  createInviteCode,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyInviteCode,
  verifyPassword,
} from './security.js';

export const SESSION_COOKIE = 'forge_session';

type Role = 'user' | 'admin';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  is_active: number;
  requires_password_setup: number;
  invite_code_hash: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface PublicUser {
  id: number;
  username: string;
  role: Role;
  isActive: boolean;
  requiresPasswordSetup: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface AuthState {
  user: PublicUser;
  tokenHash: string;
}

export interface CreateAppOptions {
  database?: Database;
  databasePath?: string;
  databaseUrl?: string;
  databaseAuthToken?: string;
  sessionDays?: number;
  cookieSecure?: boolean;
  trustProxy?: boolean | number | string;
  serveStatic?: boolean;
  distPath?: string;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);
const usernameSchema = z.string().trim().min(2).max(32).regex(
  /^[A-Za-z0-9_.-]+$/,
  'Username may only contain letters, numbers, dots, underscores and hyphens',
);
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'Color must be a six-digit hex value');
const resourceOrderSchema = z.object({
  ids: z.array(z.number().int().positive()),
}).strict();
function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return false;

  const suffix = match[4];
  if (suffix === '') return true;
  const validTime = /^T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))?$/.test(suffix);
  return validTime && !Number.isNaN(Date.parse(value));
}
const dateSchema = z.string().trim().refine(
  isValidIsoDate,
  'Date must be a valid ISO date or date-time',
);
const idSchema = z.coerce.number().int().positive();

const setupSchema = z.object({
  username: usernameSchema.default('Admin'),
  password: passwordSchema,
}).strict();
const loginSchema = z.object({ username: z.string().trim().min(1).max(32), password: z.string().max(128) }).strict();
const updateProfileSchema = z.object({ username: usernameSchema }).strict();
const changePasswordSchema = z.object({
  currentPassword: z.string().max(128),
  newPassword: passwordSchema,
}).strict().refine((value) => value.currentPassword !== value.newPassword, {
  message: 'New password must be different from the current password',
  path: ['newPassword'],
});
const activationSchema = z.object({
  username: z.string().trim().min(1).max(32),
  inviteCode: z.string().trim().min(24).max(128),
  newPassword: passwordSchema,
}).strict();

function now(): string {
  return new Date().toISOString();
}

function asIsoDate(value?: string): string {
  return value ? new Date(value).toISOString() : now();
}

function parseId(value: string): number {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'INVALID_ID', 'Resource ID must be a positive integer');
  return parsed.data;
}

function requireExactResourceOrder(
  submittedIds: number[],
  ownedRows: Array<{ id: number }>,
): void {
  const submitted = new Set(submittedIds);
  const owned = new Set(ownedRows.map((row) => Number(row.id)));
  if (
    submitted.size !== submittedIds.length
    || submittedIds.length !== ownedRows.length
    || submittedIds.some((id) => !owned.has(id))
  ) {
    throw new HttpError(
      400,
      'ORDER_IDS_MISMATCH',
      'IDs must be a duplicate-free list containing every owned resource exactly once',
    );
  }
}

function publicUser(row: UserRow): PublicUser {
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    isActive: Boolean(row.is_active),
    requiresPasswordSetup: Boolean(row.requires_password_setup),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function getAuth(response: Response): AuthState {
  const auth = response.locals.auth as AuthState | undefined;
  if (!auth) throw new HttpError(401, 'AUTH_REQUIRED', 'You must be signed in');
  return auth;
}

function getAdmin(response: Response): AuthState {
  const auth = getAuth(response);
  if (auth.user.role !== 'admin') {
    throw new HttpError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
  }
  return auth;
}

function sendData(response: Response, data: unknown, status = 200): void {
  response.status(status).json({ data });
}

function sqliteConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; errcode?: unknown };
  return String(candidate.code ?? '').startsWith('SQLITE_CONSTRAINT')
    || (typeof candidate.errcode === 'number' && (candidate.errcode & 0xff) === 19);
}

function safeMetadata(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const PRIVATE_TRAINING_TARGETS = new Set([
  'body_part',
  'measurement',
  'exercise',
  'lift',
  'workout_day',
  'meal',
  'meal_plan',
]);

function publicAuditMetadata(targetType: string, value: string | null): unknown {
  return PRIVATE_TRAINING_TARGETS.has(targetType) ? null : safeMetadata(value);
}

export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const normalized = value?.trim();
  if (!normalized || /^(?:0|false|no|off)$/i.test(normalized)) return false;
  if (/^(?:true|yes|on)$/i.test(normalized)) return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return normalized;
}

function requestIp(request: Request): string | null {
  return request.ip || request.socket.remoteAddress || null;
}

async function createSession(
  database: Database,
  userId: number,
  sessionDays: number,
  request: Request,
): Promise<{ rawToken: string; tokenHash: string; expiresAt: Date }> {
  const { rawToken, tokenHash } = createSessionToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + sessionDays * 24 * 60 * 60 * 1000);
  const result = await database.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip_address, user_agent)
    SELECT ?, id, ?, ?, ?, ? FROM users WHERE id = ? AND is_active = 1
  `).run(
    tokenHash,
    createdAt.toISOString(),
    expiresAt.toISOString(),
    requestIp(request),
    request.get('user-agent')?.slice(0, 500) ?? null,
    userId,
  );
  if (result.changes === 0) throw new HttpError(401, 'AUTH_REQUIRED', 'You must be signed in');
  return { rawToken, tokenHash, expiresAt };
}

function cookieOptions(cookieSecure: boolean, expiresAt?: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cookieSecure,
    path: '/',
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

function setSessionCookie(response: Response, rawToken: string, expiresAt: Date, secure: boolean): void {
  response.cookie(SESSION_COOKIE, rawToken, cookieOptions(secure, expiresAt));
}

function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}

function loadAuth(database: Database) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const rawToken = request.cookies?.[SESSION_COOKIE];
    if (typeof rawToken !== 'string' || rawToken.length < 20) {
      next();
      return;
    }

    const tokenHash = hashSessionToken(rawToken);
    const row = await database.prepare(`
      SELECT u.*
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1
    `).get(tokenHash, now()) as unknown as UserRow | undefined;

    if (!row) {
      await database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      clearSessionCookie(response, response.app.locals.cookieSecure as boolean);
      next();
      return;
    }

    response.locals.auth = { user: publicUser(row), tokenHash } satisfies AuthState;
    next();
  };
}

export async function createApp(options: CreateAppOptions = {}): Promise<Express> {
  let database = options.database;
  if (database) {
    await initializeDatabase(database);
  } else {
    const remoteUrl = options.databaseUrl ?? process.env.TURSO_DATABASE_URL?.trim();
    const authToken = options.databaseAuthToken ?? process.env.TURSO_AUTH_TOKEN?.trim();
    if (!remoteUrl && authToken) {
      throw new Error('TURSO_DATABASE_URL is required when TURSO_AUTH_TOKEN is configured');
    }
    const localPath = options.databasePath ?? process.env.DATABASE_PATH;
    if (process.env.NODE_ENV === 'production' && !remoteUrl && !localPath) {
      throw new Error('Production requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or an explicit persistent DATABASE_PATH');
    }
    database = await openDatabase(remoteUrl
      ? { url: remoteUrl, authToken }
      : { path: localPath ?? './data/forge.db' });
  }

  const envSessionDays = Number(process.env.SESSION_DAYS ?? 30);
  const sessionDays = options.sessionDays ?? (Number.isFinite(envSessionDays) && envSessionDays > 0 ? envSessionDays : 30);
  const cookieSecure = options.cookieSecure ?? process.env.COOKIE_SECURE === '1';
  const serveStatic = options.serveStatic ?? process.env.NODE_ENV === 'production';
  const distPath = resolve(options.distPath ?? 'dist');

  const app = express();
  app.disable('x-powered-by');
  const trustProxy = options.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY);
  app.set('trust proxy', trustProxy);
  app.locals.database = database;
  app.locals.cookieSecure = cookieSecure;
  app.locals.closeDatabase = () => database.close();

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Forge is intentionally usable on plain HTTP localhost. Helmet's default
    // upgrade directive can make some browsers request local assets over HTTPS.
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', loadAuth(database));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_request, response) => {
      response.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts; please try again later' },
      });
    },
  });
  const activationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_request, response) => {
      response.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many activation attempts; please try again later' },
      });
    },
  });

  app.get('/api/health', (_request, response) => {
    sendData(response, { status: 'ok' });
  });

  app.get('/api/auth/status', async (_request, response) => {
    const userCount = await database.prepare('SELECT COUNT(*) AS count FROM users').get() as unknown as { count: number };
    const auth = response.locals.auth as AuthState | undefined;
    sendData(response, {
      setupRequired: Number(userCount.count) === 0,
      authenticated: Boolean(auth),
      user: auth?.user ?? null,
    });
  });

  app.post('/api/auth/setup', async (request, response) => {
    const existingUsers = await database.prepare('SELECT COUNT(*) AS count FROM users').get() as unknown as { count: number };
    if (Number(existingUsers.count) !== 0) {
      throw new HttpError(409, 'ALREADY_CONFIGURED', 'Initial setup has already been completed');
    }
    const { username, password } = setupSchema.parse(request.body);
    const passwordHash = await hashPassword(password);
    let userId: number;

    try {
      userId = await runTransaction(database, async () => {
        const count = await database.prepare('SELECT COUNT(*) AS count FROM users').get() as unknown as { count: number };
        if (Number(count.count) !== 0) {
          throw new HttpError(409, 'ALREADY_CONFIGURED', 'Initial setup has already been completed');
        }

        const timestamp = now();
        const result = await database.prepare(`
          INSERT INTO users (username, password_hash, role, is_active, created_at, updated_at)
          VALUES (?, ?, 'admin', 1, ?, ?)
        `).run(username, passwordHash, timestamp, timestamp);
        const id = Number(result.lastInsertRowid);
        await seedUserDefaults(database, id);
        await writeAudit(database, {
          actorUserId: id,
          action: 'system.setup',
          targetType: 'user',
          targetId: id,
          metadata: { username, role: 'admin' },
          ipAddress: requestIp(request),
        });
        return id;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (sqliteConflict(error)) {
        throw new HttpError(409, 'ALREADY_CONFIGURED', 'Initial setup has already been completed');
      }
      throw error;
    }

    const session = await createSession(database, userId, sessionDays, request);
    setSessionCookie(response, session.rawToken, session.expiresAt, cookieSecure);
    const row = await database.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow;
    sendData(response, { user: publicUser(row) }, 201);
  });

  app.post('/api/auth/login', loginLimiter, async (request, response) => {
    const { username, password } = loginSchema.parse(request.body);
    const row = await database.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as UserRow | undefined;
    if (row?.requires_password_setup) {
      throw new HttpError(409, 'PASSWORD_SETUP_REQUIRED', 'Activate this account with its invite code before signing in');
    }
    const valid = row ? await verifyPassword(password, row.password_hash) : false;

    if (!row || !valid) {
      await writeAudit(database, {
        action: 'auth.login_failed',
        targetType: 'user',
        metadata: { username },
        ipAddress: requestIp(request),
      });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect');
    }
    if (!row.is_active) {
      await writeAudit(database, {
        actorUserId: row.id,
        action: 'auth.login_disabled',
        targetType: 'user',
        targetId: row.id,
        ipAddress: requestIp(request),
      });
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
    }

    const session = await createSession(database, row.id, sessionDays, request);
    const timestamp = now();
    await database.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, row.id);
    await writeAudit(database, {
      actorUserId: row.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: row.id,
      ipAddress: requestIp(request),
    });
    setSessionCookie(response, session.rawToken, session.expiresAt, cookieSecure);
    const refreshed = await database.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as unknown as UserRow;
    sendData(response, { user: publicUser(refreshed) });
  });

  app.post('/api/auth/activate', activationLimiter, async (request, response) => {
    const input = activationSchema.parse(request.body);
    const current = await database.prepare('SELECT * FROM users WHERE username = ?')
      .get(input.username) as unknown as UserRow | undefined;
    if (!current || !current.requires_password_setup || !verifyInviteCode(input.inviteCode, current.invite_code_hash)) {
      throw new HttpError(400, 'INVALID_INVITE_CODE', 'Username or invite code is invalid');
    }
    if (!current.is_active) {
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
    }

    const passwordHash = await hashPassword(input.newPassword);
    const timestamp = now();
    await runTransaction(database, async () => {
      const latest = await database.prepare('SELECT * FROM users WHERE id = ?').get(current.id) as unknown as UserRow | undefined;
      if (!latest || !latest.requires_password_setup || !verifyInviteCode(input.inviteCode, latest.invite_code_hash)) {
        throw new HttpError(400, 'INVALID_INVITE_CODE', 'Username or invite code is invalid');
      }
      if (!latest.is_active) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
      await database.prepare(`
        UPDATE users
        SET password_hash = ?, requires_password_setup = 0, invite_code_hash = NULL,
            last_login_at = ?, updated_at = ?
        WHERE id = ?
      `).run(passwordHash, timestamp, timestamp, latest.id);
      await database.prepare('DELETE FROM sessions WHERE user_id = ?').run(latest.id);
      await writeAudit(database, {
        actorUserId: latest.id,
        action: 'auth.account_activated',
        targetType: 'user',
        targetId: latest.id,
        ipAddress: requestIp(request),
      });
    });

    const session = await createSession(database, current.id, sessionDays, request);
    setSessionCookie(response, session.rawToken, session.expiresAt, cookieSecure);
    const activated = await database.prepare('SELECT * FROM users WHERE id = ?').get(current.id) as unknown as UserRow;
    sendData(response, { user: publicUser(activated) });
  });

  app.post('/api/auth/logout', async (_request, response) => {
    const auth = response.locals.auth as AuthState | undefined;
    if (auth) {
      await database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'auth.logout',
        targetType: 'user',
        targetId: auth.user.id,
      });
    }
    clearSessionCookie(response, cookieSecure);
    sendData(response, { success: true });
  });

  app.get('/api/auth/me', (_request, response) => {
    sendData(response, { user: getAuth(response).user });
  });

  app.patch('/api/auth/profile', async (request, response) => {
    const auth = getAuth(response);
    const { username } = updateProfileSchema.parse(request.body);

    try {
      await runTransaction(database, async () => {
        const current = await database.prepare('SELECT * FROM users WHERE id = ?')
          .get(auth.user.id) as unknown as UserRow | undefined;
        if (!current) throw new HttpError(401, 'AUTH_REQUIRED', 'You must be signed in');
        if (current.username === username) return;

        const conflictingUser = await database.prepare('SELECT id FROM users WHERE username = ? AND id != ?')
          .get(username, current.id) as unknown as { id: number } | undefined;
        if (conflictingUser) {
          throw new HttpError(409, 'USERNAME_EXISTS', 'That username is already in use');
        }

        await database.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?')
          .run(username, now(), current.id);
        await writeAudit(database, {
          actorUserId: current.id,
          action: 'auth.username_changed',
          targetType: 'user',
          targetId: current.id,
          metadata: { previousUsername: current.username, username },
          ipAddress: requestIp(request),
        });
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (sqliteConflict(error)) {
        throw new HttpError(409, 'USERNAME_EXISTS', 'That username is already in use');
      }
      throw error;
    }

    const refreshed = await database.prepare('SELECT * FROM users WHERE id = ?')
      .get(auth.user.id) as unknown as UserRow;
    sendData(response, { user: publicUser(refreshed) });
  });

  app.post('/api/auth/change-password', async (request, response) => {
    const auth = getAuth(response);
    const { currentPassword, newPassword } = changePasswordSchema.parse(request.body);
    const row = await database.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id) as unknown as UserRow;
    if (!await verifyPassword(currentPassword, row.password_hash)) {
      throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
    }

    const passwordHash = await hashPassword(newPassword);
    const timestamp = now();
    await runTransaction(database, async () => {
      await database.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, timestamp, auth.user.id);
      await database.prepare('DELETE FROM sessions WHERE user_id = ?').run(auth.user.id);
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: auth.user.id,
        ipAddress: requestIp(request),
      });
    });

    const session = await createSession(database, auth.user.id, sessionDays, request);
    setSessionCookie(response, session.rawToken, session.expiresAt, cookieSecure);
    sendData(response, { success: true });
  });

  registerBodyPartRoutes(app, database);
  registerExerciseRoutes(app, database);
  registerWorkoutPlanRoutes(app, database);
  registerMealPlanRoutes(app, database);
  registerSharingRoutes(app, database);
  registerAdminRoutes(app, database);
  registerExportRoute(app, database);

  app.use('/api', (_request, _response, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'API endpoint not found'));
  });

  if (serveStatic && existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((request, response, next) => {
      if (request.method !== 'GET') {
        next();
        return;
      }
      response.sendFile(resolve(distPath, 'index.html'));
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
      });
      return;
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } });
      return;
    }
    if (sqliteConflict(error)) {
      response.status(409).json({ error: { code: 'CONFLICT', message: 'A resource with that name already exists' } });
      return;
    }

    console.error(error);
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred' } });
  });

  return app;
}

function registerBodyPartRoutes(app: Express, database: Database): void {
  const bodyPartCreateSchema = z.object({
    name: z.string().trim().min(1).max(60),
    unit: z.string().trim().min(1).max(16).default('cm'),
    color: colorSchema.default('#f97316'),
  }).strict();
  const bodyPartUpdateSchema = z.object({
    name: z.string().trim().min(1).max(60).optional(),
    unit: z.string().trim().min(1).max(16).optional(),
    color: colorSchema.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
  const measurementCreateSchema = z.object({
    value: z.number().positive().finite(),
    recordedAt: dateSchema.optional(),
    note: z.string().trim().max(500).nullable().optional(),
  }).strict();
  const measurementUpdateSchema = z.object({
    value: z.number().positive().finite().optional(),
    recordedAt: dateSchema.optional(),
    note: z.string().trim().max(500).nullable().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

  const summarySql = `
    SELECT bp.*,
      COUNT(m.id) AS record_count,
      (SELECT value FROM measurements latest
        WHERE latest.body_part_id = bp.id
        ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1) AS latest_value,
      (SELECT recorded_at FROM measurements latest
        WHERE latest.body_part_id = bp.id
        ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1) AS latest_recorded_at
    FROM body_parts bp
    LEFT JOIN measurements m ON m.body_part_id = bp.id
  `;

  const mapBodyPart = (row: Record<string, unknown>) => ({
    id: Number(row.id),
    name: String(row.name),
    unit: String(row.unit),
    color: String(row.color),
    sortOrder: Number(row.sort_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    recordCount: Number(row.record_count ?? 0),
    latestValue: row.latest_value == null ? null : Number(row.latest_value),
    latestRecordedAt: row.latest_recorded_at == null ? null : String(row.latest_recorded_at),
  });

  const getBodyPart = async (id: number, userId: number) => {
    const row = await database.prepare(`${summarySql} WHERE bp.id = ? AND bp.user_id = ? GROUP BY bp.id`)
      .get(id, userId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'BODY_PART_NOT_FOUND', 'Body part not found');
    return mapBodyPart(row);
  };

  const ensureBodyPart = async (id: number, userId: number): Promise<void> => {
    const row = await database.prepare('SELECT id FROM body_parts WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw new HttpError(404, 'BODY_PART_NOT_FOUND', 'Body part not found');
  };

  const mapMeasurement = (row: Record<string, unknown>) => ({
    id: Number(row.id),
    bodyPartId: Number(row.body_part_id),
    value: Number(row.value),
    recordedAt: String(row.recorded_at),
    note: row.note == null ? null : String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });

  app.get('/api/body-parts', async (_request, response) => {
    const auth = getAuth(response);
    const rows = await database.prepare(`${summarySql} WHERE bp.user_id = ? GROUP BY bp.id ORDER BY bp.sort_order ASC, bp.id ASC`)
      .all(auth.user.id) as unknown as Record<string, unknown>[];
    sendData(response, { bodyParts: rows.map(mapBodyPart) });
  });

  app.put('/api/body-parts/order', async (request, response) => {
    const auth = getAuth(response);
    const { ids } = resourceOrderSchema.parse(request.body);
    const timestamp = now();
    await runTransaction(database, async () => {
      const ownedRows = await database.prepare('SELECT id FROM body_parts WHERE user_id = ?')
        .all(auth.user.id) as unknown as Array<{ id: number }>;
      requireExactResourceOrder(ids, ownedRows);
      const update = database.prepare(`
        UPDATE body_parts SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?
      `);
      for (const [position, id] of ids.entries()) {
        await update.run(position, timestamp, id, auth.user.id);
      }
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'body_parts.reordered',
        targetType: 'body_part',
        ipAddress: requestIp(request),
      });
    });
    const rows = await database.prepare(`${summarySql} WHERE bp.user_id = ? GROUP BY bp.id ORDER BY bp.sort_order ASC, bp.id ASC`)
      .all(auth.user.id) as unknown as Record<string, unknown>[];
    sendData(response, { bodyParts: rows.map(mapBodyPart) });
  });

  app.post('/api/body-parts', async (request, response) => {
    const auth = getAuth(response);
    const input = bodyPartCreateSchema.parse(request.body);
    const timestamp = now();
    let result;
    try {
      result = await database.prepare(`
        INSERT INTO body_parts (user_id, name, unit, color, sort_order, created_at, updated_at)
        SELECT users.id, ?, ?, ?, (
          SELECT COALESCE(MAX(sort_order), -1) + 1 FROM body_parts WHERE user_id = users.id
        ), ?, ?
        FROM users
        WHERE users.id = ? AND users.is_active = 1
      `).run(input.name, input.unit, input.color, timestamp, timestamp, auth.user.id);
    } catch (error) {
      if (sqliteConflict(error)) throw new HttpError(409, 'BODY_PART_EXISTS', 'A body part with that name already exists');
      throw error;
    }
    if (result.changes === 0) throw new HttpError(401, 'AUTH_REQUIRED', 'You must be signed in');
    const id = Number(result.lastInsertRowid);
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'body_part.created',
      targetType: 'body_part',
      targetId: id,
      ipAddress: requestIp(request),
    });
    sendData(response, { bodyPart: await getBodyPart(id, auth.user.id) }, 201);
  });

  app.patch('/api/body-parts/:bodyPartId', async (request, response) => {
    const auth = getAuth(response);
    const id = parseId(request.params.bodyPartId);
    const input = bodyPartUpdateSchema.parse(request.body);
    try {
      await runTransaction(database, async () => {
        const current = await database.prepare('SELECT * FROM body_parts WHERE id = ? AND user_id = ?')
          .get(id, auth.user.id) as unknown as Record<string, unknown> | undefined;
        if (!current) throw new HttpError(404, 'BODY_PART_NOT_FOUND', 'Body part not found');
        if (input.unit !== undefined && input.unit !== String(current.unit)) {
          const record = await database.prepare('SELECT 1 FROM measurements WHERE body_part_id = ? LIMIT 1').get(id);
          if (record) {
            throw new HttpError(
              409,
              'BODY_PART_UNIT_LOCKED',
              'Unit cannot be changed after measurements have been recorded; delete those records first',
            );
          }
        }

        const result = await database.prepare(`
          UPDATE body_parts SET name = ?, unit = ?, color = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(
          input.name ?? String(current.name),
          input.unit ?? String(current.unit),
          input.color ?? String(current.color),
          now(),
          id,
          auth.user.id,
        );
        if (result.changes === 0) throw new HttpError(404, 'BODY_PART_NOT_FOUND', 'Body part not found');
        await writeAudit(database, {
          actorUserId: auth.user.id,
          action: 'body_part.updated',
          targetType: 'body_part',
          targetId: id,
          ipAddress: requestIp(request),
        });
      });
    } catch (error) {
      if (sqliteConflict(error)) throw new HttpError(409, 'BODY_PART_EXISTS', 'A body part with that name already exists');
      throw error;
    }
    sendData(response, { bodyPart: await getBodyPart(id, auth.user.id) });
  });

  app.delete('/api/body-parts/:bodyPartId', async (request, response) => {
    const auth = getAuth(response);
    const id = parseId(request.params.bodyPartId);
    const current = await database.prepare('SELECT name FROM body_parts WHERE id = ? AND user_id = ?')
      .get(id, auth.user.id) as unknown as { name: string } | undefined;
    if (!current) throw new HttpError(404, 'BODY_PART_NOT_FOUND', 'Body part not found');
    await runTransaction(database, async () => {
      await database.prepare('DELETE FROM measurements WHERE body_part_id = ?').run(id);
      await database.prepare('DELETE FROM body_parts WHERE id = ? AND user_id = ?').run(id, auth.user.id);
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'body_part.deleted',
        targetType: 'body_part',
        targetId: id,
        ipAddress: requestIp(request),
      });
    });
    sendData(response, { success: true });
  });

  app.get('/api/body-parts/:bodyPartId/measurements', async (request, response) => {
    const auth = getAuth(response);
    const bodyPartId = parseId(request.params.bodyPartId);
    await ensureBodyPart(bodyPartId, auth.user.id);
    const rows = await database.prepare(`
      SELECT * FROM measurements WHERE body_part_id = ? ORDER BY recorded_at ASC, id ASC
    `).all(bodyPartId) as unknown as Record<string, unknown>[];
    sendData(response, { measurements: rows.map(mapMeasurement) });
  });

  app.post('/api/body-parts/:bodyPartId/measurements', async (request, response) => {
    const auth = getAuth(response);
    const bodyPartId = parseId(request.params.bodyPartId);
    await ensureBodyPart(bodyPartId, auth.user.id);
    const input = measurementCreateSchema.parse(request.body);
    const timestamp = now();
    const result = await database.prepare(`
      INSERT INTO measurements (body_part_id, value, recorded_at, note, created_at, updated_at)
      SELECT bp.id, ?, ?, ?, ?, ?
      FROM body_parts bp
      WHERE bp.id = ? AND bp.user_id = ?
    `).run(
      input.value,
      asIsoDate(input.recordedAt),
      input.note?.trim() || null,
      timestamp,
      timestamp,
      bodyPartId,
      auth.user.id,
    );
    if (result.changes === 0) throw new HttpError(404, 'BODY_PART_NOT_FOUND', 'Body part not found');
    const id = Number(result.lastInsertRowid);
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'measurement.created',
      targetType: 'measurement',
      targetId: id,
      ipAddress: requestIp(request),
    });
    const row = await database.prepare('SELECT * FROM measurements WHERE id = ?').get(id) as unknown as Record<string, unknown>;
    sendData(response, { measurement: mapMeasurement(row) }, 201);
  });

  app.patch('/api/body-parts/:bodyPartId/measurements/:measurementId', async (request, response) => {
    const auth = getAuth(response);
    const bodyPartId = parseId(request.params.bodyPartId);
    const measurementId = parseId(request.params.measurementId);
    await ensureBodyPart(bodyPartId, auth.user.id);
    const current = await database.prepare(`
      SELECT m.* FROM measurements m
      JOIN body_parts bp ON bp.id = m.body_part_id
      WHERE m.id = ? AND m.body_part_id = ? AND bp.user_id = ?
    `).get(measurementId, bodyPartId, auth.user.id) as unknown as Record<string, unknown> | undefined;
    if (!current) throw new HttpError(404, 'MEASUREMENT_NOT_FOUND', 'Measurement not found');
    const input = measurementUpdateSchema.parse(request.body);
    await database.prepare(`
      UPDATE measurements SET value = ?, recorded_at = ?, note = ?, updated_at = ?
      WHERE id = ? AND body_part_id = ?
    `).run(
      input.value ?? Number(current.value),
      input.recordedAt ? asIsoDate(input.recordedAt) : String(current.recorded_at),
      input.note === undefined
        ? (current.note == null ? null : String(current.note))
        : input.note?.trim() || null,
      now(),
      measurementId,
      bodyPartId,
    );
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'measurement.updated',
      targetType: 'measurement',
      targetId: measurementId,
      ipAddress: requestIp(request),
    });
    const row = await database.prepare('SELECT * FROM measurements WHERE id = ?').get(measurementId) as unknown as Record<string, unknown>;
    sendData(response, { measurement: mapMeasurement(row) });
  });

  app.delete('/api/body-parts/:bodyPartId/measurements/:measurementId', async (request, response) => {
    const auth = getAuth(response);
    const bodyPartId = parseId(request.params.bodyPartId);
    const measurementId = parseId(request.params.measurementId);
    await ensureBodyPart(bodyPartId, auth.user.id);
    const result = await database.prepare(`
      DELETE FROM measurements
      WHERE id = ? AND body_part_id = ?
        AND EXISTS (SELECT 1 FROM body_parts bp WHERE bp.id = measurements.body_part_id AND bp.user_id = ?)
    `).run(measurementId, bodyPartId, auth.user.id);
    if (Number(result.changes) === 0) throw new HttpError(404, 'MEASUREMENT_NOT_FOUND', 'Measurement not found');
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'measurement.deleted',
      targetType: 'measurement',
      targetId: measurementId,
      ipAddress: requestIp(request),
    });
    sendData(response, { success: true });
  });
}

function registerExerciseRoutes(app: Express, database: Database): void {
  const exerciseCreateSchema = z.object({
    name: z.string().trim().min(1).max(80),
    category: z.string().trim().min(1).max(40).default('Strength'),
    unit: z.string().trim().min(1).max(16).default('kg'),
    color: colorSchema.default('#f97316'),
  }).strict();
  const exerciseUpdateSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    unit: z.string().trim().min(1).max(16).optional(),
    color: colorSchema.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
  const liftCreateSchema = z.object({
    weight: z.number().positive().finite(),
    reps: z.number().int().positive().max(1000).default(1),
    recordedAt: dateSchema.optional(),
    note: z.string().trim().max(500).nullable().optional(),
  }).strict();
  const liftUpdateSchema = z.object({
    weight: z.number().positive().finite().optional(),
    reps: z.number().int().positive().max(1000).optional(),
    recordedAt: dateSchema.optional(),
    note: z.string().trim().max(500).nullable().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

  const summarySql = `
    SELECT e.*,
      COUNT(l.id) AS record_count,
      MAX(l.weight) AS personal_best,
      (SELECT weight FROM lift_records latest
        WHERE latest.exercise_id = e.id
        ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1) AS latest_weight,
      (SELECT reps FROM lift_records latest
        WHERE latest.exercise_id = e.id
        ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1) AS latest_reps,
      (SELECT recorded_at FROM lift_records latest
        WHERE latest.exercise_id = e.id
        ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1) AS latest_recorded_at
    FROM exercises e
    LEFT JOIN lift_records l ON l.exercise_id = e.id
  `;

  const mapExercise = (row: Record<string, unknown>) => ({
    id: Number(row.id),
    name: String(row.name),
    category: String(row.category),
    unit: String(row.unit),
    color: String(row.color),
    sortOrder: Number(row.sort_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    recordCount: Number(row.record_count ?? 0),
    personalBest: row.personal_best == null ? null : Number(row.personal_best),
    latestWeight: row.latest_weight == null ? null : Number(row.latest_weight),
    latestReps: row.latest_reps == null ? null : Number(row.latest_reps),
    latestRecordedAt: row.latest_recorded_at == null ? null : String(row.latest_recorded_at),
  });

  const getExercise = async (id: number, userId: number) => {
    const row = await database.prepare(`${summarySql} WHERE e.id = ? AND e.user_id = ? GROUP BY e.id`)
      .get(id, userId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'EXERCISE_NOT_FOUND', 'Exercise not found');
    return mapExercise(row);
  };

  const ensureExercise = async (id: number, userId: number): Promise<void> => {
    const row = await database.prepare('SELECT id FROM exercises WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw new HttpError(404, 'EXERCISE_NOT_FOUND', 'Exercise not found');
  };

  const mapLift = (row: Record<string, unknown>) => ({
    id: Number(row.id),
    exerciseId: Number(row.exercise_id),
    weight: Number(row.weight),
    reps: Number(row.reps),
    recordedAt: String(row.recorded_at),
    note: row.note == null ? null : String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });

  app.get('/api/exercises', async (_request, response) => {
    const auth = getAuth(response);
    const rows = await database.prepare(`${summarySql} WHERE e.user_id = ? GROUP BY e.id ORDER BY e.sort_order ASC, e.id ASC`)
      .all(auth.user.id) as unknown as Record<string, unknown>[];
    sendData(response, { exercises: rows.map(mapExercise) });
  });

  app.put('/api/exercises/order', async (request, response) => {
    const auth = getAuth(response);
    const { ids } = resourceOrderSchema.parse(request.body);
    const timestamp = now();
    await runTransaction(database, async () => {
      const ownedRows = await database.prepare('SELECT id FROM exercises WHERE user_id = ?')
        .all(auth.user.id) as unknown as Array<{ id: number }>;
      requireExactResourceOrder(ids, ownedRows);
      const update = database.prepare(`
        UPDATE exercises SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?
      `);
      for (const [position, id] of ids.entries()) {
        await update.run(position, timestamp, id, auth.user.id);
      }
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'exercises.reordered',
        targetType: 'exercise',
        ipAddress: requestIp(request),
      });
    });
    const rows = await database.prepare(`${summarySql} WHERE e.user_id = ? GROUP BY e.id ORDER BY e.sort_order ASC, e.id ASC`)
      .all(auth.user.id) as unknown as Record<string, unknown>[];
    sendData(response, { exercises: rows.map(mapExercise) });
  });

  app.post('/api/exercises', async (request, response) => {
    const auth = getAuth(response);
    const input = exerciseCreateSchema.parse(request.body);
    const timestamp = now();
    let result;
    try {
      result = await database.prepare(`
        INSERT INTO exercises (user_id, name, category, unit, color, sort_order, created_at, updated_at)
        SELECT users.id, ?, ?, ?, ?, (
          SELECT COALESCE(MAX(sort_order), -1) + 1 FROM exercises WHERE user_id = users.id
        ), ?, ?
        FROM users
        WHERE users.id = ? AND users.is_active = 1
      `).run(
        input.name,
        input.category,
        input.unit,
        input.color,
        timestamp,
        timestamp,
        auth.user.id,
      );
    } catch (error) {
      if (sqliteConflict(error)) throw new HttpError(409, 'EXERCISE_EXISTS', 'An exercise with that name already exists');
      throw error;
    }
    if (result.changes === 0) throw new HttpError(401, 'AUTH_REQUIRED', 'You must be signed in');
    const id = Number(result.lastInsertRowid);
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'exercise.created',
      targetType: 'exercise',
      targetId: id,
      ipAddress: requestIp(request),
    });
    sendData(response, { exercise: await getExercise(id, auth.user.id) }, 201);
  });

  app.patch('/api/exercises/:exerciseId', async (request, response) => {
    const auth = getAuth(response);
    const id = parseId(request.params.exerciseId);
    const input = exerciseUpdateSchema.parse(request.body);
    try {
      await runTransaction(database, async () => {
        const current = await database.prepare('SELECT * FROM exercises WHERE id = ? AND user_id = ?')
          .get(id, auth.user.id) as unknown as Record<string, unknown> | undefined;
        if (!current) throw new HttpError(404, 'EXERCISE_NOT_FOUND', 'Exercise not found');
        if (input.unit !== undefined && input.unit !== String(current.unit)) {
          const record = await database.prepare('SELECT 1 FROM lift_records WHERE exercise_id = ? LIMIT 1').get(id);
          if (record) {
            throw new HttpError(
              409,
              'EXERCISE_UNIT_LOCKED',
              'Unit cannot be changed after lift records have been recorded; delete those records first',
            );
          }
        }

        const result = await database.prepare(`
          UPDATE exercises SET name = ?, category = ?, unit = ?, color = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(
          input.name ?? String(current.name),
          input.category ?? String(current.category),
          input.unit ?? String(current.unit),
          input.color ?? String(current.color),
          now(),
          id,
          auth.user.id,
        );
        if (result.changes === 0) throw new HttpError(404, 'EXERCISE_NOT_FOUND', 'Exercise not found');
        await writeAudit(database, {
          actorUserId: auth.user.id,
          action: 'exercise.updated',
          targetType: 'exercise',
          targetId: id,
          ipAddress: requestIp(request),
        });
      });
    } catch (error) {
      if (sqliteConflict(error)) throw new HttpError(409, 'EXERCISE_EXISTS', 'An exercise with that name already exists');
      throw error;
    }
    sendData(response, { exercise: await getExercise(id, auth.user.id) });
  });

  app.delete('/api/exercises/:exerciseId', async (request, response) => {
    const auth = getAuth(response);
    const id = parseId(request.params.exerciseId);
    const current = await database.prepare('SELECT name FROM exercises WHERE id = ? AND user_id = ?')
      .get(id, auth.user.id) as unknown as { name: string } | undefined;
    if (!current) throw new HttpError(404, 'EXERCISE_NOT_FOUND', 'Exercise not found');
    await runTransaction(database, async () => {
      await database.prepare('DELETE FROM lift_records WHERE exercise_id = ?').run(id);
      await database.prepare('DELETE FROM exercises WHERE id = ? AND user_id = ?').run(id, auth.user.id);
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'exercise.deleted',
        targetType: 'exercise',
        targetId: id,
        ipAddress: requestIp(request),
      });
    });
    sendData(response, { success: true });
  });

  app.get('/api/exercises/:exerciseId/lifts', async (request, response) => {
    const auth = getAuth(response);
    const exerciseId = parseId(request.params.exerciseId);
    await ensureExercise(exerciseId, auth.user.id);
    const rows = await database.prepare(`
      SELECT * FROM lift_records WHERE exercise_id = ? ORDER BY recorded_at ASC, id ASC
    `).all(exerciseId) as unknown as Record<string, unknown>[];
    sendData(response, { lifts: rows.map(mapLift) });
  });

  app.post('/api/exercises/:exerciseId/lifts', async (request, response) => {
    const auth = getAuth(response);
    const exerciseId = parseId(request.params.exerciseId);
    await ensureExercise(exerciseId, auth.user.id);
    const input = liftCreateSchema.parse(request.body);
    const timestamp = now();
    const result = await database.prepare(`
      INSERT INTO lift_records (exercise_id, weight, reps, recorded_at, note, created_at, updated_at)
      SELECT e.id, ?, ?, ?, ?, ?, ?
      FROM exercises e
      WHERE e.id = ? AND e.user_id = ?
    `).run(
      input.weight,
      input.reps,
      asIsoDate(input.recordedAt),
      input.note?.trim() || null,
      timestamp,
      timestamp,
      exerciseId,
      auth.user.id,
    );
    if (result.changes === 0) throw new HttpError(404, 'EXERCISE_NOT_FOUND', 'Exercise not found');
    const id = Number(result.lastInsertRowid);
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'lift.created',
      targetType: 'lift',
      targetId: id,
      ipAddress: requestIp(request),
    });
    const row = await database.prepare('SELECT * FROM lift_records WHERE id = ?').get(id) as unknown as Record<string, unknown>;
    sendData(response, { lift: mapLift(row) }, 201);
  });

  app.patch('/api/exercises/:exerciseId/lifts/:liftId', async (request, response) => {
    const auth = getAuth(response);
    const exerciseId = parseId(request.params.exerciseId);
    const liftId = parseId(request.params.liftId);
    await ensureExercise(exerciseId, auth.user.id);
    const current = await database.prepare(`
      SELECT l.* FROM lift_records l
      JOIN exercises e ON e.id = l.exercise_id
      WHERE l.id = ? AND l.exercise_id = ? AND e.user_id = ?
    `).get(liftId, exerciseId, auth.user.id) as unknown as Record<string, unknown> | undefined;
    if (!current) throw new HttpError(404, 'LIFT_NOT_FOUND', 'Lift record not found');
    const input = liftUpdateSchema.parse(request.body);
    await database.prepare(`
      UPDATE lift_records SET weight = ?, reps = ?, recorded_at = ?, note = ?, updated_at = ?
      WHERE id = ? AND exercise_id = ?
    `).run(
      input.weight ?? Number(current.weight),
      input.reps ?? Number(current.reps),
      input.recordedAt ? asIsoDate(input.recordedAt) : String(current.recorded_at),
      input.note === undefined
        ? (current.note == null ? null : String(current.note))
        : input.note?.trim() || null,
      now(),
      liftId,
      exerciseId,
    );
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'lift.updated',
      targetType: 'lift',
      targetId: liftId,
      ipAddress: requestIp(request),
    });
    const row = await database.prepare('SELECT * FROM lift_records WHERE id = ?').get(liftId) as unknown as Record<string, unknown>;
    sendData(response, { lift: mapLift(row) });
  });

  app.delete('/api/exercises/:exerciseId/lifts/:liftId', async (request, response) => {
    const auth = getAuth(response);
    const exerciseId = parseId(request.params.exerciseId);
    const liftId = parseId(request.params.liftId);
    await ensureExercise(exerciseId, auth.user.id);
    const result = await database.prepare(`
      DELETE FROM lift_records
      WHERE id = ? AND exercise_id = ?
        AND EXISTS (SELECT 1 FROM exercises e WHERE e.id = lift_records.exercise_id AND e.user_id = ?)
    `).run(liftId, exerciseId, auth.user.id);
    if (Number(result.changes) === 0) throw new HttpError(404, 'LIFT_NOT_FOUND', 'Lift record not found');
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'lift.deleted',
      targetType: 'lift',
      targetId: liftId,
      ipAddress: requestIp(request),
    });
    sendData(response, { success: true });
  });
}

async function readWorkoutPlan(database: Database, userId: number, redactNotes = false) {
  await seedUserPlans(database, userId);
  const days = await database.prepare(`
    SELECT * FROM workout_days WHERE user_id = ? ORDER BY day_of_week ASC
  `).all(userId) as unknown as Record<string, unknown>[];
  return {
    days: await Promise.all(days.map(async (day) => {
      const exercises = await database.prepare(`
        SELECT * FROM workout_exercises
        WHERE workout_day_id = ? ORDER BY position ASC, id ASC
      `).all(day.id as number) as unknown as Record<string, unknown>[];
      return {
        dayOfWeek: Number(day.day_of_week),
        name: String(day.name),
        isRest: Boolean(day.is_rest),
        notes: redactNotes || day.notes == null ? null : String(day.notes),
        exercises: exercises.map((exercise) => ({
          id: Number(exercise.id),
          name: String(exercise.name),
          sets: Number(exercise.sets),
          reps: String(exercise.reps),
          notes: redactNotes || exercise.notes == null ? null : String(exercise.notes),
        })),
      };
    })),
  };
}

function registerWorkoutPlanRoutes(app: Express, database: Database): void {
  const exerciseSchema = z.object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(100),
    sets: z.number().int().min(1).max(100),
    reps: z.union([
      z.string().trim().min(1).max(40),
      z.number().positive().finite().transform(String),
    ]),
    notes: z.string().trim().max(500).nullable().optional(),
  }).strict();
  const daySchema = z.object({
    name: z.string().trim().min(1).max(100),
    isRest: z.boolean(),
    notes: z.string().trim().max(1000).nullable().optional(),
    exercises: z.array(exerciseSchema).max(50),
  }).strict();
  const parseDayOfWeek = (value: string): number => {
    const parsed = z.coerce.number().int().min(0).max(6).safeParse(value);
    if (!parsed.success) throw new HttpError(400, 'INVALID_DAY', 'dayOfWeek must be an integer from 0 to 6');
    return parsed.data;
  };

  app.get('/api/workout-plan', async (_request, response) => {
    const auth = getAuth(response);
    sendData(response, await readWorkoutPlan(database, auth.user.id));
  });

  app.put('/api/workout-plan/:dayOfWeek', async (request, response) => {
    const auth = getAuth(response);
    const dayOfWeek = parseDayOfWeek(request.params.dayOfWeek);
    const input = daySchema.parse(request.body);
    await seedUserPlans(database, auth.user.id);
    const exercises = input.isRest ? [] : input.exercises;
    const timestamp = now();

    await runTransaction(database, async () => {
      await database.prepare(`
        UPDATE workout_days
        SET name = ?, is_rest = ?, notes = ?, updated_at = ?
        WHERE user_id = ? AND day_of_week = ?
      `).run(
        input.name,
        input.isRest ? 1 : 0,
        input.notes?.trim() || null,
        timestamp,
        auth.user.id,
        dayOfWeek,
      );
      const day = await database.prepare(`
        SELECT id FROM workout_days WHERE user_id = ? AND day_of_week = ?
      `).get(auth.user.id, dayOfWeek) as unknown as { id: number };
      await database.prepare('DELETE FROM workout_exercises WHERE workout_day_id = ?').run(day.id);
      if (exercises.length > 0) {
        const placeholders = exercises.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const values = exercises.flatMap((exercise, position) => [
          day.id,
          position,
          exercise.name,
          exercise.sets,
          exercise.reps,
          exercise.notes?.trim() || null,
          timestamp,
          timestamp,
        ]);
        await database.prepare(`
          INSERT INTO workout_exercises (
            workout_day_id, position, name, sets, reps, notes, created_at, updated_at
          ) VALUES ${placeholders}
        `).run(...values);
      }
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'workout.day_updated',
        targetType: 'workout_day',
        targetId: day.id,
        ipAddress: requestIp(request),
      });
    });

    const plan = await readWorkoutPlan(database, auth.user.id);
    sendData(response, { day: plan.days.find((day) => day.dayOfWeek === dayOfWeek) });
  });
}

type BmrSex = 'female' | 'male';
type BmrWeightSource = 'manual' | 'measurement';
type BmrWeightUnit = 'kg' | 'lb' | 'st';

interface BmrWeightSnapshot {
  weightSource: BmrWeightSource;
  weightValue: number;
  weightUnit: BmrWeightUnit;
  bodyPartId: number | null;
  measurementId: number | null;
  sourceName: string | null;
  sourceRecordedAt: string | null;
}

function normalizeBmrWeightUnit(unit: string): BmrWeightUnit | null {
  const normalized = unit.trim().toLowerCase().replace(/[.\s_-]/g, '');
  if (['kg', 'kgs', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'].includes(normalized)) {
    return 'kg';
  }
  if (['lb', 'lbs', 'pound', 'pounds'].includes(normalized)) return 'lb';
  if (['st', 'stone', 'stones'].includes(normalized)) return 'st';
  return null;
}

function bmrWeightToKilograms(value: number, unit: BmrWeightUnit): number {
  if (unit === 'lb') return value * 0.45359237;
  if (unit === 'st') return value * 6.35029318;
  return value;
}

function bmrHeightToCentimetres(heightFeet: number, heightInches: number): number {
  return ((heightFeet * 12) + heightInches) * 2.54;
}

function estimateBmr(age: number, sex: BmrSex, heightCm: number, weightKg: number): number {
  return Math.round((10 * weightKg) + (6.25 * heightCm) - (5 * age) + (sex === 'male' ? 5 : -161));
}

function mapBmrProfile(row: Record<string, unknown>) {
  return {
    age: Number(row.age),
    sex: String(row.sex) as BmrSex,
    heightFeet: Number(row.height_feet),
    heightInches: Number(row.height_inches),
    weightSource: String(row.weight_source) as BmrWeightSource,
    weightValue: Number(row.weight_value),
    weightUnit: String(row.weight_unit) as BmrWeightUnit,
    bodyPartId: row.body_part_id == null ? null : Number(row.body_part_id),
    measurementId: row.measurement_id == null ? null : Number(row.measurement_id),
    sourceName: row.source_name == null ? null : String(row.source_name),
    sourceRecordedAt: row.source_recorded_at == null ? null : String(row.source_recorded_at),
    estimatedBmr: Number(row.estimated_bmr),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function readBmrProfile(database: Database, userId: number) {
  const row = await database.prepare('SELECT * FROM bmr_profiles WHERE user_id = ?')
    .get(userId) as unknown as Record<string, unknown> | undefined;
  return row ? mapBmrProfile(row) : null;
}

async function readMealPlan(database: Database, userId: number, redactDescriptions = false) {
  await seedUserPlans(database, userId);
  const settingsRow = await database.prepare(`
    SELECT * FROM meal_plan_settings WHERE user_id = ?
  `).get(userId) as unknown as Record<string, unknown>;
  const showCalories = Boolean(settingsRow.show_calories);
  const showMacros = Boolean(settingsRow.show_macros);
  const mealRows = await database.prepare(`
    SELECT * FROM meals WHERE user_id = ? ORDER BY day_of_week ASC, sort_order ASC, id ASC
  `).all(userId) as unknown as Record<string, unknown>[];
  const mapNullableNumber = (value: unknown) => value == null ? null : Number(value);
  const meals = mealRows.map((meal) => ({
    id: Number(meal.id),
    dayOfWeek: Number(meal.day_of_week),
    name: String(meal.name),
    description: redactDescriptions || meal.description == null ? null : String(meal.description),
    calories: redactDescriptions && !showCalories ? null : mapNullableNumber(meal.calories),
    protein: redactDescriptions && !showMacros ? null : mapNullableNumber(meal.protein),
    carbs: redactDescriptions && !showMacros ? null : mapNullableNumber(meal.carbs),
    fat: redactDescriptions && !showMacros ? null : mapNullableNumber(meal.fat),
    sortOrder: Number(meal.sort_order),
    createdAt: String(meal.created_at),
    updatedAt: String(meal.updated_at),
  }));
  return {
    settings: {
      showCalories,
      showMacros,
      calorieTarget: redactDescriptions && !showCalories ? null : mapNullableNumber(settingsRow.calorie_target),
      proteinTarget: redactDescriptions && !showMacros ? null : mapNullableNumber(settingsRow.protein_target),
      carbsTarget: redactDescriptions && !showMacros ? null : mapNullableNumber(settingsRow.carbs_target),
      fatTarget: redactDescriptions && !showMacros ? null : mapNullableNumber(settingsRow.fat_target),
    },
    days: Array.from({ length: 7 }, (_, dayOfWeek) => {
      const dayMeals = meals.filter((meal) => meal.dayOfWeek === dayOfWeek);
      return {
        dayOfWeek,
        meals: dayMeals,
        totals: {
          calories: dayMeals.reduce((total, meal) => total + (meal.calories ?? 0), 0),
          protein: dayMeals.reduce((total, meal) => total + (meal.protein ?? 0), 0),
          carbs: dayMeals.reduce((total, meal) => total + (meal.carbs ?? 0), 0),
          fat: dayMeals.reduce((total, meal) => total + (meal.fat ?? 0), 0),
        },
      };
    }),
  };
}

function registerMealPlanRoutes(app: Express, database: Database): void {
  const targetSchema = z.number().nonnegative().finite().max(1_000_000).nullable();
  const settingsSchema = z.object({
    showCalories: z.boolean().optional(),
    showMacros: z.boolean().optional(),
    calorieTarget: targetSchema.optional(),
    proteinTarget: targetSchema.optional(),
    carbsTarget: targetSchema.optional(),
    fatTarget: targetSchema.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one setting is required');
  const mealFields = {
    dayOfWeek: z.number().int().min(0).max(6),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).nullable().optional(),
    calories: targetSchema.optional(),
    protein: targetSchema.optional(),
    carbs: targetSchema.optional(),
    fat: targetSchema.optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  };
  const createMealSchema = z.object(mealFields).strict();
  const updateMealSchema = z.object({
    dayOfWeek: mealFields.dayOfWeek.optional(),
    name: mealFields.name.optional(),
    description: mealFields.description,
    calories: mealFields.calories,
    protein: mealFields.protein,
    carbs: mealFields.carbs,
    fat: mealFields.fat,
    sortOrder: mealFields.sortOrder,
  }).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

  const bmrSharedFields = {
    age: z.number().int().min(18).max(120),
    sex: z.enum(['female', 'male']),
    heightFeet: z.number().int().min(3).max(9),
    heightInches: z.number().finite().min(0).lt(12),
  };
  const bmrInputSchema = z.discriminatedUnion('weightSource', [
    z.object({
      ...bmrSharedFields,
      weightSource: z.literal('manual'),
      weightValue: z.number().positive().finite().max(10_000),
      weightUnit: z.enum(['kg', 'lb', 'st']),
    }).strict(),
    z.object({
      ...bmrSharedFields,
      weightSource: z.literal('measurement'),
      bodyPartId: z.number().int().positive(),
      measurementId: z.number().int().positive(),
    }).strict(),
  ]).refine(
    (value) => {
      const heightCm = bmrHeightToCentimetres(value.heightFeet, value.heightInches);
      return heightCm >= 100 && heightCm <= 275;
    },
    { message: 'Combined height must be between 100 and 275 centimetres', path: ['heightFeet'] },
  );

  app.get('/api/meal-plan/bmr', async (_request, response) => {
    const auth = getAuth(response);
    sendData(response, { bmr: await readBmrProfile(database, auth.user.id) });
  });

  app.put('/api/meal-plan/bmr', async (request, response) => {
    const auth = getAuth(response);
    const input = bmrInputSchema.parse(request.body);
    const bmr = await runTransaction(database, async () => {
      let snapshot: BmrWeightSnapshot;

      if (input.weightSource === 'manual') {
        snapshot = {
          weightSource: 'manual',
          weightValue: input.weightValue,
          weightUnit: input.weightUnit,
          bodyPartId: null,
          measurementId: null,
          sourceName: null,
          sourceRecordedAt: null,
        };
      } else {
        const source = await database.prepare(`
          SELECT
            bp.id AS body_part_id,
            bp.name AS source_name,
            bp.unit AS source_unit,
            m.id AS measurement_id,
            m.value AS source_value,
            m.recorded_at AS source_recorded_at
          FROM body_parts bp
          JOIN measurements m ON m.body_part_id = bp.id
          WHERE bp.id = ? AND m.id = ? AND bp.user_id = ?
        `).get(input.bodyPartId, input.measurementId, auth.user.id) as unknown as Record<string, unknown> | undefined;
        if (!source) {
          throw new HttpError(404, 'BMR_MEASUREMENT_NOT_FOUND', 'That saved weight measurement was not found');
        }
        const unit = normalizeBmrWeightUnit(String(source.source_unit));
        if (!unit) {
          throw new HttpError(
            400,
            'BMR_WEIGHT_UNIT_UNSUPPORTED',
            'The selected measurement must use kilograms, pounds, or stone',
          );
        }
        snapshot = {
          weightSource: 'measurement',
          weightValue: Number(source.source_value),
          weightUnit: unit,
          bodyPartId: Number(source.body_part_id),
          measurementId: Number(source.measurement_id),
          sourceName: String(source.source_name),
          sourceRecordedAt: String(source.source_recorded_at),
        };
      }

      const heightCm = bmrHeightToCentimetres(input.heightFeet, input.heightInches);
      const weightKg = bmrWeightToKilograms(snapshot.weightValue, snapshot.weightUnit);
      if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 500) {
        throw new HttpError(400, 'BMR_WEIGHT_OUT_OF_RANGE', 'Weight must be between 20 and 500 kilograms');
      }
      const estimatedBmr = estimateBmr(input.age, input.sex, heightCm, weightKg);
      if (!Number.isFinite(estimatedBmr) || estimatedBmr <= 0) {
        throw new HttpError(400, 'BMR_RESULT_INVALID', 'Those details could not produce a valid BMR estimate');
      }

      const timestamp = now();
      await database.prepare(`
        INSERT INTO bmr_profiles (
          user_id, age, sex, height_feet, height_inches, weight_source,
          weight_value, weight_unit, body_part_id, measurement_id,
          source_name, source_recorded_at, estimated_bmr, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          age = excluded.age,
          sex = excluded.sex,
          height_feet = excluded.height_feet,
          height_inches = excluded.height_inches,
          weight_source = excluded.weight_source,
          weight_value = excluded.weight_value,
          weight_unit = excluded.weight_unit,
          body_part_id = excluded.body_part_id,
          measurement_id = excluded.measurement_id,
          source_name = excluded.source_name,
          source_recorded_at = excluded.source_recorded_at,
          estimated_bmr = excluded.estimated_bmr,
          updated_at = excluded.updated_at
      `).run(
        auth.user.id,
        input.age,
        input.sex,
        input.heightFeet,
        input.heightInches,
        snapshot.weightSource,
        snapshot.weightValue,
        snapshot.weightUnit,
        snapshot.bodyPartId,
        snapshot.measurementId,
        snapshot.sourceName,
        snapshot.sourceRecordedAt,
        estimatedBmr,
        timestamp,
        timestamp,
      );
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'meal.bmr_updated',
        targetType: 'meal_plan',
        targetId: auth.user.id,
        ipAddress: requestIp(request),
      });

      const stored = await readBmrProfile(database, auth.user.id);
      if (!stored) throw new Error('BMR profile was not saved');
      return stored;
    });
    sendData(response, { bmr });
  });

  app.get('/api/meal-plan', async (_request, response) => {
    const auth = getAuth(response);
    sendData(response, await readMealPlan(database, auth.user.id));
  });

  app.put('/api/meal-plan/settings', async (request, response) => {
    const auth = getAuth(response);
    const input = settingsSchema.parse(request.body);
    await seedUserPlans(database, auth.user.id);
    const current = await database.prepare('SELECT * FROM meal_plan_settings WHERE user_id = ?')
      .get(auth.user.id) as unknown as Record<string, unknown>;
    await database.prepare(`
      UPDATE meal_plan_settings
      SET show_calories = ?, show_macros = ?, calorie_target = ?, protein_target = ?,
          carbs_target = ?, fat_target = ?, updated_at = ?
      WHERE user_id = ?
    `).run(
      input.showCalories === undefined ? Number(current.show_calories) : input.showCalories ? 1 : 0,
      input.showMacros === undefined ? Number(current.show_macros) : input.showMacros ? 1 : 0,
      input.calorieTarget === undefined ? current.calorie_target as number | null : input.calorieTarget,
      input.proteinTarget === undefined ? current.protein_target as number | null : input.proteinTarget,
      input.carbsTarget === undefined ? current.carbs_target as number | null : input.carbsTarget,
      input.fatTarget === undefined ? current.fat_target as number | null : input.fatTarget,
      now(),
      auth.user.id,
    );
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'meal.settings_updated',
      targetType: 'meal_plan',
      targetId: auth.user.id,
      ipAddress: requestIp(request),
    });
    sendData(response, { settings: (await readMealPlan(database, auth.user.id)).settings });
  });

  app.post('/api/meal-plan/meals', async (request, response) => {
    const auth = getAuth(response);
    const input = createMealSchema.parse(request.body);
    await seedUserPlans(database, auth.user.id);
    const timestamp = now();
    const result = await database.prepare(`
      INSERT INTO meals (
        user_id, day_of_week, name, description, calories, protein, carbs, fat,
        sort_order, created_at, updated_at
      )
      SELECT users.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM users
      WHERE users.id = ? AND users.is_active = 1
    `).run(
      input.dayOfWeek,
      input.name,
      input.description?.trim() || null,
      input.calories ?? null,
      input.protein ?? null,
      input.carbs ?? null,
      input.fat ?? null,
      input.sortOrder ?? 0,
      timestamp,
      timestamp,
      auth.user.id,
    );
    if (result.changes === 0) throw new HttpError(401, 'AUTH_REQUIRED', 'You must be signed in');
    const id = Number(result.lastInsertRowid);
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'meal.created',
      targetType: 'meal',
      targetId: id,
      ipAddress: requestIp(request),
    });
    const meal = (await readMealPlan(database, auth.user.id)).days
      .flatMap((day) => day.meals).find((item) => item.id === id);
    sendData(response, { meal }, 201);
  });

  app.patch('/api/meal-plan/meals/:mealId', async (request, response) => {
    const auth = getAuth(response);
    const mealId = parseId(request.params.mealId);
    const input = updateMealSchema.parse(request.body);
    const current = await database.prepare('SELECT * FROM meals WHERE id = ? AND user_id = ?')
      .get(mealId, auth.user.id) as unknown as Record<string, unknown> | undefined;
    if (!current) throw new HttpError(404, 'MEAL_NOT_FOUND', 'Meal not found');
    await database.prepare(`
      UPDATE meals SET day_of_week = ?, name = ?, description = ?, calories = ?, protein = ?,
        carbs = ?, fat = ?, sort_order = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      input.dayOfWeek ?? Number(current.day_of_week),
      input.name ?? String(current.name),
      input.description === undefined ? current.description as string | null : input.description?.trim() || null,
      input.calories === undefined ? current.calories as number | null : input.calories,
      input.protein === undefined ? current.protein as number | null : input.protein,
      input.carbs === undefined ? current.carbs as number | null : input.carbs,
      input.fat === undefined ? current.fat as number | null : input.fat,
      input.sortOrder ?? Number(current.sort_order),
      now(),
      mealId,
      auth.user.id,
    );
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'meal.updated',
      targetType: 'meal',
      targetId: mealId,
      ipAddress: requestIp(request),
    });
    const meal = (await readMealPlan(database, auth.user.id)).days
      .flatMap((day) => day.meals).find((item) => item.id === mealId);
    sendData(response, { meal });
  });

  app.delete('/api/meal-plan/meals/:mealId', async (request, response) => {
    const auth = getAuth(response);
    const mealId = parseId(request.params.mealId);
    const result = await database.prepare('DELETE FROM meals WHERE id = ? AND user_id = ?').run(mealId, auth.user.id);
    if (Number(result.changes) === 0) throw new HttpError(404, 'MEAL_NOT_FOUND', 'Meal not found');
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'meal.deleted',
      targetType: 'meal',
      targetId: mealId,
      ipAddress: requestIp(request),
    });
    sendData(response, { success: true });
  });
}

function registerSharingRoutes(app: Express, database: Database): void {
  const permissionFields = {
    shareMeasurements: z.boolean().optional(),
    shareLifts: z.boolean().optional(),
    shareWorkout: z.boolean().optional(),
    shareMeals: z.boolean().optional(),
  };
  const createShareSchema = z.object({
    viewerUserId: z.number().int().positive(),
    ...permissionFields,
  }).strict();
  const updateShareSchema = z.object(permissionFields).strict()
    .refine((value) => Object.keys(value).length > 0, 'At least one permission is required');
  const requirePermission = (permissions: {
    shareMeasurements?: boolean;
    shareLifts?: boolean;
    shareWorkout?: boolean;
    shareMeals?: boolean;
  }): void => {
    if (!permissions.shareMeasurements && !permissions.shareLifts
      && !permissions.shareWorkout && !permissions.shareMeals) {
      throw new HttpError(
        400,
        'SHARE_REQUIRES_PERMISSION',
        'Enable at least one sharing permission, or revoke the share instead',
      );
    }
  };
  const shareSelect = `
    SELECT sp.*,
      owner.id AS owner_id, owner.username AS owner_username,
      viewer.id AS viewer_id, viewer.username AS viewer_username
    FROM sharing_permissions sp
    JOIN users owner ON owner.id = sp.owner_user_id
    JOIN users viewer ON viewer.id = sp.viewer_user_id
  `;
  const mapShare = (row: Record<string, unknown>) => ({
    id: Number(row.id),
    owner: { id: Number(row.owner_id), username: String(row.owner_username) },
    viewer: { id: Number(row.viewer_id), username: String(row.viewer_username) },
    shareMeasurements: Boolean(row.can_view_measurements),
    shareLifts: Boolean(row.can_view_lifts),
    shareWorkout: Boolean(row.can_view_workout),
    shareMeals: Boolean(row.can_view_meals),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  const getOwnedShare = async (shareId: number, ownerUserId: number) => {
    const row = await database.prepare(`${shareSelect} WHERE sp.id = ? AND sp.owner_user_id = ?`)
      .get(shareId, ownerUserId) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'SHARE_NOT_FOUND', 'Sharing permission not found');
    return mapShare(row);
  };

  app.get('/api/sharing', async (_request, response) => {
    const auth = getAuth(response);
    const availableUsers = await database.prepare(`
      SELECT u.id, u.username FROM users u
      WHERE u.id != ? AND u.is_active = 1 AND u.requires_password_setup = 0
        AND NOT EXISTS (
          SELECT 1 FROM sharing_permissions sp
          WHERE sp.owner_user_id = ? AND sp.viewer_user_id = u.id
        )
      ORDER BY u.username COLLATE NOCASE
    `).all(auth.user.id, auth.user.id) as unknown as Array<{ id: number; username: string }>;
    const outgoing = await database.prepare(`${shareSelect} WHERE sp.owner_user_id = ? ORDER BY viewer.username COLLATE NOCASE`)
      .all(auth.user.id) as unknown as Record<string, unknown>[];
    const incoming = await database.prepare(`${shareSelect} WHERE sp.viewer_user_id = ? ORDER BY owner.username COLLATE NOCASE`)
      .all(auth.user.id) as unknown as Record<string, unknown>[];
    sendData(response, {
      availableUsers: availableUsers.map((user) => ({ id: Number(user.id), username: user.username })),
      outgoingShares: outgoing.map(mapShare),
      incomingShares: incoming.map(mapShare),
    });
  });

  app.post('/api/sharing', async (request, response) => {
    const auth = getAuth(response);
    const input = createShareSchema.parse(request.body);
    requirePermission(input);
    if (input.viewerUserId === auth.user.id) {
      throw new HttpError(400, 'CANNOT_SHARE_WITH_SELF', 'You cannot share progress with yourself');
    }
    const viewer = await database.prepare(`
      SELECT id, username FROM users
      WHERE id = ? AND is_active = 1 AND requires_password_setup = 0
    `)
      .get(input.viewerUserId) as unknown as { id: number; username: string } | undefined;
    if (!viewer) throw new HttpError(404, 'VIEWER_NOT_FOUND', 'Viewer account not found');
    const timestamp = now();
    let result;
    try {
      result = await database.prepare(`
        INSERT INTO sharing_permissions (
          owner_user_id, viewer_user_id, can_view_measurements, can_view_lifts,
          can_view_workout, can_view_meals, created_at, updated_at
        )
        SELECT owner.id, viewer.id, ?, ?, ?, ?, ?, ?
        FROM users owner
        JOIN users viewer
          ON viewer.id = ? AND viewer.is_active = 1 AND viewer.requires_password_setup = 0
        WHERE owner.id = ? AND owner.is_active = 1
      `).run(
        input.shareMeasurements ? 1 : 0,
        input.shareLifts ? 1 : 0,
        input.shareWorkout ? 1 : 0,
        input.shareMeals ? 1 : 0,
        timestamp,
        timestamp,
        viewer.id,
        auth.user.id,
      );
    } catch (error) {
      if (sqliteConflict(error)) throw new HttpError(409, 'SHARE_EXISTS', 'Progress is already shared with this user');
      throw error;
    }
    if (result.changes === 0) {
      const owner = await database.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1')
        .get(auth.user.id);
      if (!owner) throw new HttpError(401, 'AUTH_REQUIRED', 'You must be signed in');
      throw new HttpError(404, 'VIEWER_NOT_FOUND', 'Viewer account not found');
    }
    const id = Number(result.lastInsertRowid);
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'sharing.created',
      targetType: 'sharing',
      targetId: id,
      metadata: { viewerUsername: viewer.username },
      ipAddress: requestIp(request),
    });
    sendData(response, { share: await getOwnedShare(id, auth.user.id) }, 201);
  });

  app.patch('/api/sharing/:shareId', async (request, response) => {
    const auth = getAuth(response);
    const shareId = parseId(request.params.shareId);
    const input = updateShareSchema.parse(request.body);
    const current = await getOwnedShare(shareId, auth.user.id);
    const nextPermissions = {
      shareMeasurements: input.shareMeasurements ?? current.shareMeasurements,
      shareLifts: input.shareLifts ?? current.shareLifts,
      shareWorkout: input.shareWorkout ?? current.shareWorkout,
      shareMeals: input.shareMeals ?? current.shareMeals,
    };
    requirePermission(nextPermissions);
    await database.prepare(`
      UPDATE sharing_permissions
      SET can_view_measurements = ?, can_view_lifts = ?, can_view_workout = ?,
          can_view_meals = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?
    `).run(
      nextPermissions.shareMeasurements ? 1 : 0,
      nextPermissions.shareLifts ? 1 : 0,
      nextPermissions.shareWorkout ? 1 : 0,
      nextPermissions.shareMeals ? 1 : 0,
      now(),
      shareId,
      auth.user.id,
    );
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'sharing.updated',
      targetType: 'sharing',
      targetId: shareId,
      metadata: { viewerUsername: current.viewer.username },
      ipAddress: requestIp(request),
    });
    sendData(response, { share: await getOwnedShare(shareId, auth.user.id) });
  });

  app.delete('/api/sharing/:shareId', async (request, response) => {
    const auth = getAuth(response);
    const shareId = parseId(request.params.shareId);
    const current = await getOwnedShare(shareId, auth.user.id);
    await database.prepare('DELETE FROM sharing_permissions WHERE id = ? AND owner_user_id = ?')
      .run(shareId, auth.user.id);
    await writeAudit(database, {
      actorUserId: auth.user.id,
      action: 'sharing.deleted',
      targetType: 'sharing',
      targetId: shareId,
      metadata: { viewerUsername: current.viewer.username },
      ipAddress: requestIp(request),
    });
    sendData(response, { success: true });
  });

  app.get('/api/shared/:ownerUserId', async (request, response) => {
    const auth = getAuth(response);
    const ownerUserId = parseId(request.params.ownerUserId);
    const row = await database.prepare(`
      SELECT sp.*, owner.username AS owner_username
      FROM sharing_permissions sp
      JOIN users owner ON owner.id = sp.owner_user_id
      WHERE sp.owner_user_id = ? AND sp.viewer_user_id = ? AND owner.is_active = 1
    `).get(ownerUserId, auth.user.id) as unknown as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'SHARE_NOT_FOUND', 'Shared progress not found');
    const permissions = {
      shareMeasurements: Boolean(row.can_view_measurements),
      shareLifts: Boolean(row.can_view_lifts),
      shareWorkout: Boolean(row.can_view_workout),
      shareMeals: Boolean(row.can_view_meals),
    };
    sendData(response, {
      owner: { id: ownerUserId, username: String(row.owner_username) },
      permissions,
      ...(permissions.shareMeasurements ? { measurements: await readSharedMeasurements(database, ownerUserId) } : {}),
      ...(permissions.shareLifts ? { lifts: await readSharedLifts(database, ownerUserId) } : {}),
      ...(permissions.shareWorkout ? { workoutPlan: await readWorkoutPlan(database, ownerUserId, true) } : {}),
      ...(permissions.shareMeals ? { mealPlan: await readMealPlan(database, ownerUserId, true) } : {}),
    });
  });
}

async function readSharedMeasurements(database: Database, ownerUserId: number) {
  const parts = await database.prepare(`
    SELECT * FROM body_parts WHERE user_id = ? ORDER BY sort_order ASC, id ASC
  `).all(ownerUserId) as unknown as Record<string, unknown>[];
  return Promise.all(parts.map(async (part) => {
    const records = await database.prepare(`
      SELECT * FROM measurements WHERE body_part_id = ? ORDER BY recorded_at ASC, id ASC
    `).all(part.id as number) as unknown as Record<string, unknown>[];
    const latest = records.at(-1);
    return {
      bodyPart: {
        id: Number(part.id),
        name: String(part.name),
        unit: String(part.unit),
        color: String(part.color),
        sortOrder: Number(part.sort_order),
        createdAt: String(part.created_at),
        updatedAt: String(part.updated_at),
        recordCount: records.length,
        latestValue: latest ? Number(latest.value) : null,
        latestRecordedAt: latest ? String(latest.recorded_at) : null,
      },
      records: records.map((record) => ({
        id: Number(record.id),
        bodyPartId: Number(record.body_part_id),
        value: Number(record.value),
        recordedAt: String(record.recorded_at),
        note: null,
        createdAt: String(record.created_at),
        updatedAt: String(record.updated_at),
      })),
    };
  }));
}

async function readSharedLifts(database: Database, ownerUserId: number) {
  const exercises = await database.prepare(`
    SELECT * FROM exercises WHERE user_id = ? ORDER BY sort_order ASC, id ASC
  `).all(ownerUserId) as unknown as Record<string, unknown>[];
  return Promise.all(exercises.map(async (exercise) => {
    const records = await database.prepare(`
      SELECT * FROM lift_records WHERE exercise_id = ? ORDER BY recorded_at ASC, id ASC
    `).all(exercise.id as number) as unknown as Record<string, unknown>[];
    const latest = records.at(-1);
    const best = records.reduce<number | null>(
      (value, record) => value == null ? Number(record.weight) : Math.max(value, Number(record.weight)),
      null,
    );
    return {
      exercise: {
        id: Number(exercise.id),
        name: String(exercise.name),
        category: String(exercise.category),
        unit: String(exercise.unit),
        color: String(exercise.color),
        sortOrder: Number(exercise.sort_order),
        createdAt: String(exercise.created_at),
        updatedAt: String(exercise.updated_at),
        recordCount: records.length,
        personalBest: best,
        latestWeight: latest ? Number(latest.weight) : null,
        latestReps: latest ? Number(latest.reps) : null,
        latestRecordedAt: latest ? String(latest.recorded_at) : null,
      },
      records: records.map((record) => ({
        id: Number(record.id),
        exerciseId: Number(record.exercise_id),
        weight: Number(record.weight),
        reps: Number(record.reps),
        recordedAt: String(record.recorded_at),
        note: null,
        createdAt: String(record.created_at),
        updatedAt: String(record.updated_at),
      })),
    };
  }));
}

function registerAdminRoutes(app: Express, database: Database): void {
  const createUserSchema = z.object({
    username: usernameSchema,
    // The first-run account is the sole administrator. Invited friends are members.
    role: z.literal('user').default('user'),
  }).strict();
  const statusSchema = z.object({ isActive: z.boolean() }).strict();
  const auditQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  const mapAdminUser = (row: UserRow & Record<string, unknown>) => ({
    ...publicUser(row),
    bodyPartCount: Number(row.body_part_count ?? 0),
    measurementCount: Number(row.measurement_count ?? 0),
    exerciseCount: Number(row.exercise_count ?? 0),
    liftCount: Number(row.lift_count ?? 0),
  });

  const mapAudit = (row: Record<string, unknown>) => {
    const targetType = String(row.target_type);
    return {
      id: Number(row.id),
      actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
      actorUsername: row.actor_username == null ? null : String(row.actor_username),
      action: String(row.action),
      targetType,
      targetId: row.target_id == null ? null : String(row.target_id),
      metadata: publicAuditMetadata(targetType, row.metadata == null ? null : String(row.metadata)),
      ipAddress: row.ip_address == null ? null : String(row.ip_address),
      createdAt: String(row.created_at),
    };
  };

  const fetchUser = async (userId: number): Promise<UserRow> => {
    const row = await database.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow | undefined;
    if (!row) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');
    return row;
  };

  const countOtherActiveAdmins = async (userId: number): Promise<number> => {
    const row = await database.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?
    `).get(userId) as unknown as { count: number };
    return Number(row.count);
  };

  app.get('/api/admin/overview', async (_request, response) => {
    getAdmin(response);
    const userStats = await database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_active = 1 AND requires_password_setup = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN is_active = 1 AND requires_password_setup = 1 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS disabled,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
      FROM users
    `).get() as unknown as { total: number; active: number; pending: number; disabled: number; admins: number };
    const recordStats = await database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM body_parts) AS body_parts,
        (SELECT COUNT(*) FROM measurements) AS measurements,
        (SELECT COUNT(*) FROM exercises) AS exercises,
        (SELECT COUNT(*) FROM lift_records) AS lifts,
        (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS active_sessions
    `).get(now()) as unknown as Record<string, number>;
    const recentRows = await database.prepare(`
      SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 10
    `).all() as unknown as Record<string, unknown>[];

    sendData(response, {
      users: {
        total: Number(userStats.total ?? 0),
        active: Number(userStats.active ?? 0),
        pending: Number(userStats.pending ?? 0),
        disabled: Number(userStats.disabled ?? 0),
        admins: Number(userStats.admins ?? 0),
      },
      records: {
        bodyParts: Number(recordStats.body_parts ?? 0),
        measurements: Number(recordStats.measurements ?? 0),
        exercises: Number(recordStats.exercises ?? 0),
        lifts: Number(recordStats.lifts ?? 0),
      },
      activeSessions: Number(recordStats.active_sessions ?? 0),
      recentAudit: recentRows.map(mapAudit),
    });
  });

  app.get('/api/admin/users', async (_request, response) => {
    getAdmin(response);
    const rows = await database.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM body_parts bp WHERE bp.user_id = u.id) AS body_part_count,
        (SELECT COUNT(*) FROM measurements m JOIN body_parts bp ON bp.id = m.body_part_id WHERE bp.user_id = u.id) AS measurement_count,
        (SELECT COUNT(*) FROM exercises e WHERE e.user_id = u.id) AS exercise_count,
        (SELECT COUNT(*) FROM lift_records l JOIN exercises e ON e.id = l.exercise_id WHERE e.user_id = u.id) AS lift_count
      FROM users u ORDER BY u.created_at ASC, u.id ASC
    `).all() as unknown as (UserRow & Record<string, unknown>)[];
    sendData(response, { users: rows.map(mapAdminUser) });
  });

  app.post('/api/admin/users', async (request, response) => {
    const auth = getAdmin(response);
    const input = createUserSchema.parse(request.body);
    const invite = createInviteCode();
    const timestamp = now();
    let userId: number;
    try {
      userId = await runTransaction(database, async () => {
        const result = await database.prepare(`
          INSERT INTO users (
            username, password_hash, role, is_active, requires_password_setup,
            invite_code_hash, created_at, updated_at
          ) VALUES (?, '', ?, 1, 1, ?, ?, ?)
        `).run(input.username, input.role, invite.inviteCodeHash, timestamp, timestamp);
        const id = Number(result.lastInsertRowid);
        await seedUserDefaults(database, id);
        await writeAudit(database, {
          actorUserId: auth.user.id,
          action: 'admin.user_created',
          targetType: 'user',
          targetId: id,
          metadata: { username: input.username, role: input.role },
          ipAddress: requestIp(request),
        });
        return id;
      });
    } catch (error) {
      if (sqliteConflict(error)) throw new HttpError(409, 'USERNAME_EXISTS', 'That username is already in use');
      throw error;
    }
    sendData(response, { user: publicUser(await fetchUser(userId)), inviteCode: invite.inviteCode }, 201);
  });

  app.patch('/api/admin/users/:userId/status', async (request, response) => {
    const auth = getAdmin(response);
    const userId = parseId(request.params.userId);
    const { isActive } = statusSchema.parse(request.body);

    if (userId === auth.user.id && !isActive) {
      throw new HttpError(400, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account');
    }

    await runTransaction(database, async () => {
      const target = await fetchUser(userId);
      if (
        target.role === 'admin'
        && target.is_active
        && !isActive
        && await countOtherActiveAdmins(userId) === 0
      ) {
        throw new HttpError(409, 'LAST_ACTIVE_ADMIN', 'The last active administrator cannot be disabled');
      }
      await database.prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
        .run(isActive ? 1 : 0, now(), userId);
      if (!isActive) await database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: isActive ? 'admin.user_activated' : 'admin.user_disabled',
        targetType: 'user',
        targetId: userId,
        metadata: { username: target.username },
        ipAddress: requestIp(request),
      });
    });
    sendData(response, { user: publicUser(await fetchUser(userId)) });
  });

  app.post('/api/admin/users/:userId/reset-invite', async (request, response) => {
    const auth = getAdmin(response);
    const userId = parseId(request.params.userId);
    const target = await fetchUser(userId);
    if (userId === auth.user.id) {
      throw new HttpError(400, 'CANNOT_RESET_SELF', 'You cannot reset your own account invitation');
    }
    const invite = createInviteCode();
    await runTransaction(database, async () => {
      await database.prepare(`
        UPDATE users
        SET password_hash = '', is_active = 1, requires_password_setup = 1,
            invite_code_hash = ?, updated_at = ?
        WHERE id = ?
      `).run(invite.inviteCodeHash, now(), userId);
      await database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'admin.invite_reset',
        targetType: 'user',
        targetId: userId,
        metadata: { username: target.username },
        ipAddress: requestIp(request),
      });
    });
    sendData(response, { user: publicUser(await fetchUser(userId)), inviteCode: invite.inviteCode });
  });

  app.delete('/api/admin/users/:userId', async (request, response) => {
    const auth = getAdmin(response);
    const userId = parseId(request.params.userId);
    if (userId === auth.user.id) {
      throw new HttpError(400, 'CANNOT_DELETE_SELF', 'You cannot delete your own account');
    }

    await runTransaction(database, async () => {
      const target = await fetchUser(userId);
      if (target.role === 'admin' && await countOtherActiveAdmins(userId) === 0) {
        throw new HttpError(409, 'LAST_ACTIVE_ADMIN', 'The last active administrator cannot be deleted');
      }
      await writeAudit(database, {
        actorUserId: auth.user.id,
        action: 'admin.user_deleted',
        targetType: 'user',
        targetId: userId,
        metadata: { username: target.username, role: target.role },
        ipAddress: requestIp(request),
      });
      // Turso documents foreign-key enforcement as connection-scoped and off by
      // default, so hosted deletes must not rely on ON DELETE CASCADE alone.
      await database.prepare(`
        DELETE FROM measurements
        WHERE body_part_id IN (SELECT id FROM body_parts WHERE user_id = ?)
      `).run(userId);
      await database.prepare('DELETE FROM body_parts WHERE user_id = ?').run(userId);
      await database.prepare(`
        DELETE FROM lift_records
        WHERE exercise_id IN (SELECT id FROM exercises WHERE user_id = ?)
      `).run(userId);
      await database.prepare('DELETE FROM exercises WHERE user_id = ?').run(userId);
      await database.prepare(`
        DELETE FROM workout_exercises
        WHERE workout_day_id IN (SELECT id FROM workout_days WHERE user_id = ?)
      `).run(userId);
      await database.prepare('DELETE FROM workout_days WHERE user_id = ?').run(userId);
      await database.prepare('DELETE FROM meals WHERE user_id = ?').run(userId);
      await database.prepare('DELETE FROM bmr_profiles WHERE user_id = ?').run(userId);
      await database.prepare('DELETE FROM meal_plan_settings WHERE user_id = ?').run(userId);
      await database.prepare(`
        DELETE FROM sharing_permissions WHERE owner_user_id = ? OR viewer_user_id = ?
      `).run(userId, userId);
      await database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      await database.prepare('UPDATE audit_log SET actor_user_id = NULL WHERE actor_user_id = ?').run(userId);
      await database.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
    sendData(response, { success: true });
  });

  app.get('/api/admin/audit', async (request, response) => {
    getAdmin(response);
    const { limit, offset } = auditQuerySchema.parse(request.query);
    const count = await database.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as unknown as { count: number };
    const rows = await database.prepare(`
      SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as unknown as Record<string, unknown>[];
    sendData(response, {
      auditEntries: rows.map(mapAudit),
      pagination: { total: Number(count.count), limit, offset },
    });
  });
}

function registerExportRoute(app: Express, database: Database): void {
  app.get('/api/export', async (_request, response) => {
    const auth = getAuth(response);
    const bodyPartRows = await database.prepare(`
      SELECT * FROM body_parts WHERE user_id = ? ORDER BY sort_order ASC, id ASC
    `).all(auth.user.id) as unknown as Record<string, unknown>[];
    const exerciseRows = await database.prepare(`
      SELECT * FROM exercises WHERE user_id = ? ORDER BY sort_order ASC, id ASC
    `).all(auth.user.id) as unknown as Record<string, unknown>[];

    const bodyParts = await Promise.all(bodyPartRows.map(async (part) => {
      const measurements = await database.prepare(`
        SELECT id, value, recorded_at, note, created_at, updated_at
        FROM measurements WHERE body_part_id = ? ORDER BY recorded_at ASC, id ASC
      `).all(part.id as number) as unknown as Record<string, unknown>[];
      return {
        id: Number(part.id),
        name: String(part.name),
        unit: String(part.unit),
        color: String(part.color),
        sortOrder: Number(part.sort_order),
        createdAt: String(part.created_at),
        updatedAt: String(part.updated_at),
        measurements: measurements.map((measurement) => ({
          id: Number(measurement.id),
          value: Number(measurement.value),
          recordedAt: String(measurement.recorded_at),
          note: measurement.note == null ? null : String(measurement.note),
          createdAt: String(measurement.created_at),
          updatedAt: String(measurement.updated_at),
        })),
      };
    }));

    const exercises = await Promise.all(exerciseRows.map(async (exercise) => {
      const lifts = await database.prepare(`
        SELECT id, weight, reps, recorded_at, note, created_at, updated_at
        FROM lift_records WHERE exercise_id = ? ORDER BY recorded_at ASC, id ASC
      `).all(exercise.id as number) as unknown as Record<string, unknown>[];
      return {
        id: Number(exercise.id),
        name: String(exercise.name),
        category: String(exercise.category),
        unit: String(exercise.unit),
        color: String(exercise.color),
        sortOrder: Number(exercise.sort_order),
        createdAt: String(exercise.created_at),
        updatedAt: String(exercise.updated_at),
        lifts: lifts.map((lift) => ({
          id: Number(lift.id),
          weight: Number(lift.weight),
          reps: Number(lift.reps),
          recordedAt: String(lift.recorded_at),
          note: lift.note == null ? null : String(lift.note),
          createdAt: String(lift.created_at),
          updatedAt: String(lift.updated_at),
        })),
      };
    }));

    const shareRows = await database.prepare(`
      SELECT sp.*,
        owner.id AS owner_id, owner.username AS owner_username,
        viewer.id AS viewer_id, viewer.username AS viewer_username
      FROM sharing_permissions sp
      JOIN users owner ON owner.id = sp.owner_user_id
      JOIN users viewer ON viewer.id = sp.viewer_user_id
      WHERE sp.owner_user_id = ? OR sp.viewer_user_id = ?
      ORDER BY sp.created_at ASC, sp.id ASC
    `).all(auth.user.id, auth.user.id) as unknown as Record<string, unknown>[];
    const mapShare = (share: Record<string, unknown>) => ({
      id: Number(share.id),
      owner: { id: Number(share.owner_id), username: String(share.owner_username) },
      viewer: { id: Number(share.viewer_id), username: String(share.viewer_username) },
      shareMeasurements: Boolean(share.can_view_measurements),
      shareLifts: Boolean(share.can_view_lifts),
      shareWorkout: Boolean(share.can_view_workout),
      shareMeals: Boolean(share.can_view_meals),
      createdAt: String(share.created_at),
      updatedAt: String(share.updated_at),
    });

    response.setHeader('Content-Disposition', `attachment; filename="forge-export-${new Date().toISOString().slice(0, 10)}.json"`);
    sendData(response, {
      formatVersion: 3,
      exportedAt: now(),
      user: auth.user,
      bodyParts,
      exercises,
      workoutPlan: await readWorkoutPlan(database, auth.user.id),
      mealPlan: await readMealPlan(database, auth.user.id),
      bmrProfile: await readBmrProfile(database, auth.user.id),
      sharing: {
        outgoingShares: shareRows.filter((share) => Number(share.owner_user_id) === auth.user.id).map(mapShare),
        incomingShares: shareRows.filter((share) => Number(share.viewer_user_id) === auth.user.id).map(mapShare),
      },
    });
  });
}
