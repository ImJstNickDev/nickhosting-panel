import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const opaqueToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
export function equalToken(candidate: string, expected: string): boolean {
  return timingSafeEqual(
    Buffer.from(tokenHash(candidate), 'hex'),
    Buffer.from(tokenHash(expected), 'hex'),
  );
}
