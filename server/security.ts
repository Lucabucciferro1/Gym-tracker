import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEY_LENGTH = 64;
const PASSWORD_PREFIX = 'scrypt';

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `${PASSWORD_PREFIX}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [prefix, encodedSalt, encodedKey] = storedHash.split('$');
  if (prefix !== PASSWORD_PREFIX || !encodedSalt || !encodedKey) return false;

  try {
    const expected = Buffer.from(encodedKey, 'base64url');
    const actual = await deriveKey(password, Buffer.from(encodedSalt, 'base64url'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('base64url');
  return { rawToken, tokenHash: hashSessionToken(rawToken) };
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function createInviteCode(): { inviteCode: string; inviteCodeHash: string } {
  const inviteCode = randomBytes(24).toString('base64url');
  return { inviteCode, inviteCodeHash: hashInviteCode(inviteCode) };
}

export function hashInviteCode(inviteCode: string): string {
  return createHash('sha256').update(inviteCode, 'utf8').digest('hex');
}

export function verifyInviteCode(inviteCode: string, storedHash: string | null): boolean {
  if (!storedHash || !/^[a-f0-9]{64}$/i.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(hashInviteCode(inviteCode), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
