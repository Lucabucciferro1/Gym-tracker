import { describe, expect, it } from 'vitest';

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../server/security.js';

describe('password security', () => {
  it('hashes passwords with a unique salt and verifies only the original value', async () => {
    const firstHash = await hashPassword('Correct horse battery staple!');
    const secondHash = await hashPassword('Correct horse battery staple!');

    expect(firstHash).not.toBe('Correct horse battery staple!');
    expect(secondHash).not.toBe(firstHash);
    await expect(verifyPassword('Correct horse battery staple!', firstHash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', firstHash)).resolves.toBe(false);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'not-a-supported-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$invalid$invalid')).resolves.toBe(false);
  });
});

describe('session tokens', () => {
  it('returns only a one-way digest suitable for database storage', () => {
    const { rawToken, tokenHash } = createSessionToken();

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(rawToken.length).toBeGreaterThanOrEqual(40);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toContain(rawToken);
    expect(hashSessionToken(rawToken)).toBe(tokenHash);
  });

  it('does not generate the same bearer token twice', () => {
    expect(createSessionToken().rawToken).not.toBe(createSessionToken().rawToken);
  });
});
