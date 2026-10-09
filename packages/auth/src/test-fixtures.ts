import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { Identity } from './index.js';

let clientIndex = 1;
export class AuthClient {
  private readonly cookies = new Map<string, string>();
  private readonly ip = `192.0.2.${clientIndex++}`;
  constructor(
    readonly identity: Identity,
    readonly origin = 'http://localhost:3999',
  ) {}
  headers(extra?: Record<string, string>): Headers {
    return new Headers({
      origin: this.origin,
      // This helper calls the internal auth handler, after the API trust boundary.
      'x-nh-client-ip': this.ip,
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...extra,
    });
  }
  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? '';
      const position = pair.indexOf('=');
      if (position > 0) this.cookies.set(pair.slice(0, position), pair.slice(position + 1));
    }
  }
  async request(path: string, body?: unknown, extra?: Record<string, string>): Promise<Response> {
    const headers = this.headers(extra);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.identity.handler(
      new Request(new URL(`/api/auth${path}`, this.origin), {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    this.absorb(response);
    return response;
  }
}

export function totp(secret: string, time = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replaceAll('=', ''))
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

// Tiny CBOR writer for a software authenticator fixture. Production uses SimpleWebAuthn.
function cbor(value: unknown): Buffer {
  function head(major: number, length: number) {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}

export class SoftwareAuthenticator {
  private readonly pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  private readonly id = randomBytes(32);
  private counter = 0;
  constructor(private readonly origin = 'http://localhost:3999') {}
  registration(challenge: string, userVerified = true) {
    const key = this.pair.publicKey.export({ format: 'jwk' });
    if (!key.x || !key.y) throw new Error('Expected EC fixture coordinates');
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(key.x, 'base64url')],
        [-3, Buffer.from(key.y, 'base64url')],
      ]),
    );
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      createHash('sha256').update(new URL(this.origin).hostname).digest(),
      Buffer.from([userVerified ? 0x45 : 0x41]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      length,
      this.id,
      cose,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    return {
      id: this.id.toString('base64url'),
      rawId: this.id.toString('base64url'),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: cbor({ fmt: 'none', attStmt: {}, authData }).toString('base64url'),
        transports: ['internal'],
      },
    };
  }
  assertion(challenge: string, userVerified = true) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const authenticatorData = Buffer.concat([
      createHash('sha256').update(new URL(this.origin).hostname).digest(),
      Buffer.from([userVerified ? 0x05 : 0x01]),
      counter,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: this.origin, crossOrigin: false }),
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
      this.pair.privateKey,
    );
    return {
      id: this.id.toString('base64url'),
      rawId: this.id.toString('base64url'),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: null,
      },
    };
  }
}
