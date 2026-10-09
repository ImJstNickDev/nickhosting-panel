import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type {
  GatewayMode,
  GatewayProtocolAdapter,
  GatewayProtocolContext,
  GatewayProtocolSession,
  GatewayRoute,
} from '@nickhosting/game-sdk';

/** Release labels, wire IDs and loader/runtime metadata are separate. These
 * entries come from the reviewed registry, never from client input. Registry
 * membership is recognition evidence, not a claim of real-client verification. */
export interface MinecraftProtocolVersion {
  release: string;
  protocolId: number;
  family: 'netty' | 'legacy';
  transfer: boolean;
}
export interface MinecraftProtocolOptions {
  versions: readonly MinecraftProtocolVersion[];
  supportedReleases: readonly string[];
  acceptsTransfers?: boolean;
  probeTimeoutMs?: number;
  maxStatusBytes?: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const maximumHandshakeBytes = 4096;
const maximumHostnameCharacters = 261;
const messages = {
  en: {
    sleeping: 'Server sleeping. Join to start it.',
    waking: 'Server starting. Please reconnect shortly.',
    blocked: 'Server cannot start right now. Please try again later.',
    maintenance: 'Server under maintenance. Please try again later.',
    manually_stopped: 'Server stopped. Start it from the panel.',
    online: 'Server becoming available. Please reconnect shortly.',
    incompatible: 'Use the Minecraft version selected for this server.',
    transfer: 'Transfers are not enabled. Connect to this server directly.',
  },
  it: {
    sleeping: 'Server in sospensione. Connettiti per avviarlo.',
    waking: 'Server in avvio. Riconnettiti tra poco.',
    blocked: 'Impossibile avviare il server ora. Riprova più tardi.',
    maintenance: 'Server in manutenzione. Riprova più tardi.',
    manually_stopped: 'Server arrestato. Avvialo dal pannello.',
    online: 'Server quasi disponibile. Riconnettiti tra poco.',
    incompatible: 'Usa la versione di Minecraft selezionata per questo server.',
    transfer: 'Trasferimenti non abilitati. Connettiti direttamente al server.',
  },
} as const;

export function encodeMinecraftVarInt(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff)
    throw new Error('minecraft.invalid_varint');
  const output: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    output.push(next | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(output);
}

function varInt(input: Uint8Array, offset = 0): { value: number; bytes: number } | undefined {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    const byte = input[offset + index];
    if (byte === undefined) return undefined;
    if (index === 4 && (byte & 0xf8) !== 0) throw new Error('minecraft.invalid_varint');
    value += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0) {
      return { value, bytes: index + 1 };
    }
  }
  throw new Error('minecraft.invalid_varint');
}

export function frameMinecraftPacket(id: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const body = Buffer.concat([encodeMinecraftVarInt(id), payload]);
  return Buffer.concat([encodeMinecraftVarInt(body.length), body]);
}

export function readMinecraftFrame(
  input: Uint8Array,
  maximumBytes: number,
): { body: Buffer; bytes: number } | undefined {
  const length = varInt(input);
  if (!length) return undefined;
  if (length.bytes > 3 || length.value < 1 || length.value > maximumBytes)
    throw new Error('minecraft.invalid_frame');
  if (input.length < length.bytes + length.value) return undefined;
  return {
    body: Buffer.from(input.subarray(length.bytes, length.bytes + length.value)),
    bytes: length.bytes + length.value,
  };
}

function stringBytes(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeMinecraftVarInt(bytes.length), bytes]);
}
function textPacket(value: unknown) {
  return frameMinecraftPacket(0, stringBytes(JSON.stringify(value)));
}
function handshake(protocolId: number, address: string, port: number) {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return frameMinecraftPacket(
    0,
    Buffer.concat([
      encodeMinecraftVarInt(protocolId),
      stringBytes(address),
      portBytes,
      encodeMinecraftVarInt(1),
    ]),
  );
}
function decodeHandshake(body: Buffer) {
  let offset = 0;
  const integer = () => {
    const result = varInt(body, offset);
    if (!result) throw new Error('minecraft.truncated_handshake');
    offset += result.bytes;
    return result.value;
  };
  if (integer() !== 0) throw new Error('minecraft.invalid_handshake');
  const protocolId = integer();
  const hostLength = integer();
  if (
    hostLength < 1 ||
    hostLength > maximumHostnameCharacters * 3 ||
    offset + hostLength + 3 > body.length
  )
    throw new Error('minecraft.invalid_hostname');
  // Opaque hostname, including bounded Forge NUL markers. Never used for
  // routing, DNS, authorization, logging, or backend selection.
  const hostname = decoder.decode(body.subarray(offset, offset + hostLength));
  if (hostname.length > maximumHostnameCharacters) throw new Error('minecraft.invalid_hostname');
  offset += hostLength;
  const port = body.readUInt16BE(offset);
  offset += 2;
  const intent = integer();
  if (offset !== body.length || port === 0 || ![1, 2, 3].includes(intent))
    throw new Error('minecraft.invalid_handshake');
  return { protocolId, intent };
}

/** Queries only the authorized exact route backend. A valid matching status
 * response AND random ping echo prove protocol responsiveness. Missing player
 * data remains unknown, never zero. No connection data is cached across probes. */
export async function probeMinecraftStatus(
  context: GatewayProtocolContext,
  version: MinecraftProtocolVersion,
  options: { timeoutMs?: number; maximumBytes?: number } = {},
): Promise<{ ready: boolean; playerCount?: number }> {
  if (context.signal.aborted || context.route.public.transport !== 'tcp') return { ready: false };
  const maximum = options.maximumBytes ?? 262144;
  const timeout = options.timeoutMs ?? 3000;
  if (
    !Number.isInteger(maximum) ||
    maximum < 256 ||
    maximum > 1048576 ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 30000 ||
    version.family !== 'netty' ||
    version.release !== context.route.protocol?.gameVersion
  )
    return { ready: false };
  return new Promise((resolve) => {
    const socket = connect({
      host: context.route.backend.address,
      port: context.route.backend.port,
    });
    const nonce = randomBytes(8);
    let buffered = Buffer.alloc(0);
    let total = 0;
    let receivedStatus = false;
    let count: number | undefined;
    let done = false;
    const finish = (ready: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(
        ready
          ? { ready: true, ...(count === undefined ? {} : { playerCount: count }) }
          : { ready: false },
      );
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, timeout);
    timer.unref();
    context.signal.addEventListener('abort', abort, { once: true });
    socket.once('error', abort);
    socket.once('close', abort);
    socket.once('connect', () => {
      if (context.signal.aborted) return abort();
      socket.write(
        Buffer.concat([
          handshake(version.protocolId, context.route.backend.address, context.route.backend.port),
          frameMinecraftPacket(0),
        ]),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        total += chunk.length;
        if (total > maximum + 32) return abort();
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length) {
          const frame = readMinecraftFrame(buffered, maximum);
          if (!frame) return;
          buffered = buffered.subarray(frame.bytes);
          const packet = varInt(frame.body);
          if (!packet) return abort();
          if (receivedStatus) {
            if (
              frame.body.length !== packet.bytes + 8 ||
              packet.value !== 1 ||
              !frame.body.subarray(packet.bytes).equals(nonce) ||
              buffered.length
            )
              return abort();
            return finish(true);
          }
          if (packet.value !== 0) return abort();
          const size = varInt(frame.body, packet.bytes);
          if (!size || packet.bytes + size.bytes + size.value !== frame.body.length) return abort();
          const status: unknown = JSON.parse(
            decoder.decode(frame.body.subarray(packet.bytes + size.bytes)),
          );
          if (!status || typeof status !== 'object' || !('version' in status)) return abort();
          const remote = status.version;
          if (
            !remote ||
            typeof remote !== 'object' ||
            !('protocol' in remote) ||
            remote.protocol !== version.protocolId
          )
            return abort();
          if (
            'players' in status &&
            status.players &&
            typeof status.players === 'object' &&
            'online' in status.players
          ) {
            const online = status.players.online;
            if (
              typeof online === 'number' &&
              Number.isSafeInteger(online) &&
              online >= 0 &&
              online <= 1000000
            )
              count = online;
          }
          receivedStatus = true;
          // Challenge is sent only AFTER the status frame, so an unsolicited
          // precomputed echo cannot establish readiness.
          if (buffered.length) return abort();
          socket.write(frameMinecraftPacket(1, nonce));
        }
      } catch {
        abort();
      }
    });
  });
}

export function createMinecraftProtocolAdapter(
  options: MinecraftProtocolOptions,
): GatewayProtocolAdapter {
  const acceptsTransfers = options.acceptsTransfers ?? false;
  const probeTimeoutMs = options.probeTimeoutMs ?? 3000;
  const maxStatusBytes = options.maxStatusBytes ?? 262144;
  if (
    typeof acceptsTransfers !== 'boolean' ||
    !Number.isInteger(probeTimeoutMs) ||
    probeTimeoutMs < 1 ||
    probeTimeoutMs > 30000 ||
    !Number.isInteger(maxStatusBytes) ||
    maxStatusBytes < 256 ||
    maxStatusBytes > 1048576
  )
    throw new Error('minecraft.invalid_protocol_configuration');
  const releases = new Map<string, MinecraftProtocolVersion>();
  const protocols = new Map<number, MinecraftProtocolVersion>();
  for (const input of options.versions) {
    const entry = { ...input };
    if (
      !entry.release ||
      entry.release.length > 128 ||
      releases.has(entry.release) ||
      !Number.isInteger(entry.protocolId) ||
      entry.protocolId < 0 ||
      entry.protocolId > 0x7fffffff ||
      !['netty', 'legacy'].includes(entry.family) ||
      typeof entry.transfer !== 'boolean' ||
      (entry.transfer && (entry.family !== 'netty' || entry.protocolId < 766))
    )
      throw new Error('minecraft.invalid_registry');
    const existing = entry.family === 'netty' ? protocols.get(entry.protocolId) : undefined;
    if (existing && (existing.family !== entry.family || existing.transfer !== entry.transfer))
      throw new Error('minecraft.conflicting_registry');
    releases.set(entry.release, entry);
    if (entry.family === 'netty') protocols.set(entry.protocolId, entry);
  }
  const supported = new Set(options.supportedReleases);
  if ([...supported].some((release) => releases.get(release)?.family !== 'netty'))
    throw new Error('minecraft.unsupported_release');
  const selected = (route: Readonly<GatewayRoute>) => {
    const release = route.protocol?.gameVersion;
    return release &&
      supported.has(release) &&
      route.public.transport === 'tcp' &&
      route.protocol?.role === 'game'
      ? releases.get(release)
      : undefined;
  };
  const createSession = (context: GatewayProtocolContext): GatewayProtocolSession => {
    const version = selected(context.route);
    if (!version) throw new Error('minecraft.unsupported_release');
    let phase: 'handshake' | 'status' | 'ping' | 'done' = 'handshake';
    let reply: 'status' | 'ping' | 'login' | 'incompatible' | 'transfer' | undefined;
    let ping: Buffer | undefined;
    return {
      classify(input) {
        if (context.signal.aborted || phase === 'done')
          return { kind: 'unsupported', consumedBytes: input.length };
        try {
          const frame = readMinecraftFrame(input, maximumHandshakeBytes);
          if (!frame) return { kind: 'need-more', consumedBytes: 0 };
          const consumedBytes = frame.bytes;
          if (phase === 'handshake') {
            const parsed = decodeHandshake(frame.body);
            const client = protocols.get(parsed.protocolId);
            if (client?.family !== 'netty') return { kind: 'unsupported', consumedBytes };
            if (parsed.intent === 1) {
              phase = 'status';
              return { kind: 'continue', consumedBytes };
            }
            phase = 'done';
            if (parsed.intent === 3 && !client.transfer)
              return { kind: 'unsupported', consumedBytes };
            if (parsed.protocolId !== version.protocolId) {
              reply = 'incompatible';
              return { kind: 'reject', consumedBytes };
            }
            if (parsed.intent === 3 && !acceptsTransfers) {
              reply = 'transfer';
              return { kind: 'reject', consumedBytes };
            }
            reply = 'login';
            return { kind: 'join', consumedBytes };
          }
          const packet = varInt(frame.body);
          if (phase === 'status' && packet?.value === 0 && frame.body.length === packet.bytes) {
            phase = 'ping';
            reply = 'status';
            return { kind: 'status', consumedBytes };
          }
          if (phase === 'ping' && packet?.value === 1 && frame.body.length === packet.bytes + 8) {
            phase = 'done';
            reply = 'ping';
            ping = Buffer.from(frame.body.subarray(packet.bytes));
            return { kind: 'status', consumedBytes };
          }
          phase = 'done';
          return { kind: 'unsupported', consumedBytes };
        } catch {
          phase = 'done';
          return { kind: 'unsupported', consumedBytes: input.length };
        }
      },
      response(mode: GatewayMode) {
        if (context.signal.aborted) return { close: true };
        const action = reply;
        reply = undefined;
        if (action === 'ping' && ping) return { bytes: frameMinecraftPacket(1, ping), close: true };
        const catalog = messages[context.route.locale];
        if (action === 'status')
          return {
            bytes: textPacket({
              version: { name: version.release, protocol: version.protocolId },
              description: { text: catalog[mode] },
            }),
            close: false,
          };
        if (action === 'login' || action === 'incompatible' || action === 'transfer')
          return {
            bytes: textPacket({ text: catalog[action === 'login' ? mode : action] }),
            close: true,
          };
        return { close: true };
      },
    };
  };
  const probe = async (
    context: GatewayProtocolContext,
  ): Promise<{ ready: boolean; playerCount?: number }> => {
    const version = selected(context.route);
    return version
      ? probeMinecraftStatus(context, version, {
          timeoutMs: probeTimeoutMs,
          maximumBytes: maxStatusBytes,
        })
      : { ready: false };
  };
  return {
    id: 'minecraft-java',
    supports: (route) => !!selected(route),
    createSession,
    // Minecraft is TCP-only and requires a per-connection status/ping dialogue.
    // Fail closed if invoked by an older stateless data plane.
    classify: () => ({ kind: 'unsupported' }),
    response: () => undefined,
    probeReadiness: probe,
    async probeIdle(context) {
      const result = await probe(context);
      return result.ready && result.playerCount !== undefined
        ? { idle: result.playerCount === 0, playerCount: result.playerCount }
        : { idle: false };
    },
  };
}
