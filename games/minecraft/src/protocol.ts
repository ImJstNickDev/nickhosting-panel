import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { type MinecraftGatewayResponses, minecraftGatewayResponsesSchema } from '@nickhosting/core';
import type {
  GatewayProbeDiagnostic,
  GatewayProtocolAdapter,
  GatewayProtocolContext,
  GatewayProtocolSession,
  GatewayResponseMode,
  GatewayRoute,
} from '@nickhosting/game-sdk';
import {
  detectMinecraftInitial,
  encodeMinecraftFrame,
  encodeSignedVarInt,
  encodeUtf16String,
  formattingToComponents,
  type LegacyStatusVariant,
  legacyKickPacket,
  legacyStatusPacket,
  type MinecraftWireCodec,
  readMinecraftWireFrame,
  readSignedVarInt,
  readUtf8String,
  readUtf16String,
} from './protocol-codecs.js';
import { minecraftLegacyMultiline, minecraftLegacyStatusVariant } from './protocol-profiles.js';

/** Owner-approved lifecycle source; actual idle counts still come from protocol status. */
export const minecraftReadinessSource = 'provider_running' as const;

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
  responses?: MinecraftGatewayResponses;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const maximumHandshakeBytes = 4096;
const messages = {
  en: {
    sleeping: 'Server sleeping. Join to start it.',
    waking: 'Server starting. Please reconnect shortly.',
    stopping: 'Server stopping. Please try again shortly.',
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
    stopping: 'Server in spegnimento. Riprova tra poco.',
    blocked: 'Impossibile avviare il server ora. Riprova più tardi.',
    maintenance: 'Server in manutenzione. Riprova più tardi.',
    manually_stopped: 'Server arrestato. Avvialo dal pannello.',
    online: 'Server quasi disponibile. Riconnettiti tra poco.',
    incompatible: 'Usa la versione di Minecraft selezionata per questo server.',
    transfer: 'Trasferimenti non abilitati. Connettiti direttamente al server.',
  },
} as const;

export const encodeMinecraftVarInt = encodeSignedVarInt;
export const frameMinecraftPacket = encodeMinecraftFrame;
export const readMinecraftFrame = readMinecraftWireFrame;
const varInt = (input: Uint8Array, offset = 0) => {
  const result = readSignedVarInt(input, offset);
  return result && { value: result.value, bytes: result.bytes };
};

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
/** Queries only the authorized exact route backend. A valid matching status
 * response AND random ping echo prove protocol responsiveness. Missing player
 * data remains unknown, never zero. No connection data is cached across probes. */
export async function probeMinecraftStatus(
  context: GatewayProtocolContext,
  version: MinecraftProtocolVersion,
  options: { timeoutMs?: number; maximumBytes?: number } = {},
): Promise<{ ready: boolean; playerCount?: number }> {
  const started = performance.now();
  let stageStarted = started;
  let stage: Exclude<GatewayProbeDiagnostic['stage'], 'total'> = 'tcp_connect';
  const diagnostic = (event: GatewayProbeDiagnostic) => {
    try {
      context.onProbeDiagnostic?.(event);
    } catch {
      /* Diagnostics never affect readiness. */
    }
  };
  const emit = (
    name: GatewayProbeDiagnostic['stage'],
    since: number,
    reason?: GatewayProbeDiagnostic['reason'],
  ) =>
    diagnostic({
      stage: name,
      durationMs: performance.now() - since,
      outcome: reason ? 'failed' : 'ok',
      ...(reason ? { reason } : {}),
    });
  if (context.signal.aborted || context.route.public.transport !== 'tcp') {
    emit('total', started, context.signal.aborted ? 'aborted' : 'unsupported');
    return { ready: false };
  }
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
  ) {
    emit('total', started, 'unsupported');
    return { ready: false };
  }
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
    const finish = (ready: boolean, reason?: GatewayProbeDiagnostic['reason']) => {
      if (done) return;
      done = true;
      emit(stage, stageStarted, reason);
      emit('total', started, reason);
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(
        ready
          ? { ready: true, ...(count === undefined ? {} : { playerCount: count }) }
          : { ready: false },
      );
    };
    const abort = () => finish(false, 'aborted');
    const invalid = () => finish(false, 'invalid_frame');
    const timer = setTimeout(() => finish(false, 'timeout'), timeout);
    timer.unref();
    context.signal.addEventListener('abort', abort, { once: true });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(false, error.code === 'ECONNREFUSED' ? 'connection_refused' : 'socket_error'),
    );
    socket.once('close', () => finish(false, 'socket_closed'));
    socket.once('connect', () => {
      if (context.signal.aborted) return abort();
      emit('tcp_connect', stageStarted);
      stage = 'status_response';
      stageStarted = performance.now();
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
        if (total > maximum + 32) return invalid();
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length) {
          const frame = readMinecraftFrame(buffered, maximum);
          if (!frame) return;
          buffered = buffered.subarray(frame.bytes);
          const packet = varInt(frame.body);
          if (!packet) return invalid();
          if (receivedStatus) {
            if (
              frame.body.length !== packet.bytes + 8 ||
              packet.value !== 1 ||
              !frame.body.subarray(packet.bytes).equals(nonce) ||
              buffered.length
            )
              return invalid();
            return finish(true);
          }
          if (packet.value !== 0) return invalid();
          const size = varInt(frame.body, packet.bytes);
          if (!size || packet.bytes + size.bytes + size.value !== frame.body.length)
            return invalid();
          const status: unknown = JSON.parse(
            decoder.decode(frame.body.subarray(packet.bytes + size.bytes)),
          );
          if (!status || typeof status !== 'object' || !('version' in status)) return invalid();
          const remote = status.version;
          if (
            !remote ||
            typeof remote !== 'object' ||
            !('protocol' in remote) ||
            remote.protocol !== version.protocolId
          )
            return finish(false, 'protocol_mismatch');
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
          if (buffered.length) return invalid();
          emit('status_response', stageStarted);
          stage = 'pong';
          stageStarted = performance.now();
          socket.write(frameMinecraftPacket(1, nonce));
        }
      } catch {
        invalid();
      }
    });
  });
}

/** Legacy status is observation only: no login, command or change to the backend.
 * No status support means unknown player count, never an inferred empty server. */
export async function probeMinecraftLegacyStatus(
  context: GatewayProtocolContext,
  version: MinecraftProtocolVersion,
  options: { timeoutMs?: number; maximumBytes?: number } = {},
): Promise<{ ready: boolean; playerCount?: number }> {
  const variant = minecraftLegacyStatusVariant(version.release);
  if (
    !variant ||
    context.signal.aborted ||
    context.route.public.transport !== 'tcp' ||
    version.release !== context.route.protocol?.gameVersion
  )
    return { ready: false };
  return new Promise((resolve) => {
    const socket = connect({
      host: context.route.backend.address,
      port: context.route.backend.port,
    });
    let buffered = Buffer.alloc(0);
    let done = false;
    const finish = (result: { ready: boolean; playerCount?: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(result);
    };
    const abort = () => finish({ ready: false });
    const timer = setTimeout(abort, options.timeoutMs ?? 3000);
    timer.unref();
    context.signal.addEventListener('abort', abort, { once: true });
    socket.once('error', abort);
    socket.once('close', abort);
    socket.once('connect', () => {
      if (context.signal.aborted) return abort();
      if (variant === 'original') return void socket.write(Buffer.from([254]));
      if (!/^1\.6(?:\.|$)/.test(version.release)) return void socket.write(Buffer.from([254, 1]));
      const host = encodeUtf16String(context.route.backend.address);
      const port = Buffer.alloc(4);
      port.writeUInt32BE(context.route.backend.port);
      const payload = Buffer.concat([Buffer.from([version.protocolId]), host, port]);
      const size = Buffer.alloc(2);
      size.writeUInt16BE(payload.length);
      socket.write(
        Buffer.concat([
          Buffer.from([254, 1, 250]),
          encodeUtf16String('MC|PingHost'),
          size,
          payload,
        ]),
      );
    });
    socket.on('data', (bytes: Buffer) => {
      if (buffered.length + bytes.length > (options.maximumBytes ?? 262144)) return abort();
      buffered = Buffer.concat([buffered, bytes]);
      try {
        if (buffered[0] !== 255) return abort();
        const message = readUtf16String(buffered, 1, 32767);
        if (!message) return;
        if (buffered.length !== message.bytes + 1) return abort();
        const parts = message.value.split(variant === 'original' ? '§' : '\0');
        if (
          variant === 'extended' &&
          (parts.length !== 6 || parts[0] !== '§1' || Number(parts[1]) !== version.protocolId)
        )
          return abort();
        if (parts.length < 3) return abort();
        const online = parts.at(-2),
          max = parts.at(-1);
        if (
          !online ||
          !max ||
          !/^\d{1,7}$/.test(online) ||
          !/^\d{1,7}$/.test(max) ||
          Number(online) > 1000000 ||
          Number(max) > 1000000
        )
          return abort();
        finish({ ready: true, playerCount: Number(online) });
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
  if ([...supported].some((release) => !releases.has(release)))
    throw new Error('minecraft.unsupported_release');
  const responses = minecraftGatewayResponsesSchema.parse(options.responses ?? {});
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
    let phase: 'handshake' | 'status' | 'ping' | 'login' | 'done' = 'handshake';
    let reply: 'status' | 'ping' | 'login' | 'incompatible' | 'transfer' | undefined;
    let codec: MinecraftWireCodec = 'netty';
    let legacyVariant: LegacyStatusVariant = 'extended';
    let clientProtocol: number | undefined;
    let loginReply: 'login' | 'incompatible' | 'transfer' = 'login';
    let ping: Buffer | undefined;
    const diagnostic = (
      action: 'status' | 'login' | 'incompatible' | 'transfer',
      announcedProtocol?: number,
    ) => {
      try {
        context.onSessionDiagnostic?.({ family: codec, clientProtocol, announcedProtocol, action });
      } catch {
        /* Diagnostics do not affect traffic. */
      }
    };
    const classify = (
      input: Uint8Array,
      finalize = false,
    ): ReturnType<GatewayProtocolSession['classify']> => {
      if (context.signal.aborted || phase === 'done')
        return { kind: 'unsupported', consumedBytes: input.length };
      try {
        if (phase === 'handshake') {
          const parsed = detectMinecraftInitial(input, {
            finalize,
            maximumBytes: maximumHandshakeBytes,
          });
          if (parsed.kind === 'need-more') return { kind: 'need-more', consumedBytes: 0 };
          if (parsed.kind === 'invalid')
            return { kind: 'unsupported', consumedBytes: input.length };
          codec = parsed.codec;
          clientProtocol = parsed.protocolId;
          const consumedBytes = parsed.bytes;
          if (parsed.kind === 'status') {
            if (codec === 'netty') {
              phase = 'status';
              return { kind: 'continue', consumedBytes };
            }
            legacyVariant = parsed.statusVariant ?? 'original';
            phase = 'done';
            reply = 'status';
            return { kind: 'status', consumedBytes };
          }
          const mismatch =
            codec === 'netty'
              ? version.family !== 'netty' || clientProtocol !== version.protocolId
              : version.family !== 'legacy' ||
                (clientProtocol !== undefined && clientProtocol !== version.protocolId);
          loginReply = mismatch
            ? 'incompatible'
            : parsed.intent === 3 && !acceptsTransfers
              ? 'transfer'
              : 'login';
          if (parsed.intent === 3 && (clientProtocol === undefined || clientProtocol < 766))
            return { kind: 'unsupported', consumedBytes };
          if (codec === 'netty') {
            phase = 'login';
            return { kind: 'continue', consumedBytes };
          }
          phase = 'done';
          reply = loginReply;
          return { kind: loginReply === 'login' ? 'join' : 'reject', consumedBytes };
        }
        const frame = readMinecraftFrame(input, maximumHandshakeBytes);
        if (!frame) return { kind: 'need-more', consumedBytes: 0 };
        const consumedBytes = frame.bytes;
        const packet = varInt(frame.body);
        if (phase === 'login' && packet?.value === 0) {
          // Username is common to modern Login Start. The bounded suffix changes
          // between releases; no authentication or gameplay fields are emulated.
          const username = readUtf8String(frame.body, packet.bytes, 16);
          if (!username?.value || /[\0-\x20]/.test(username.value))
            throw new Error('minecraft.invalid_login');
          phase = 'done';
          reply = loginReply;
          return { kind: loginReply === 'login' ? 'join' : 'reject', consumedBytes };
        }
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
    };
    return {
      classificationIdleMs: 50,
      classify: (input) => classify(input),
      finalize: (input) => classify(input, true),
      response(mode: GatewayResponseMode) {
        if (context.signal.aborted) return { close: true };
        const action = reply;
        reply = undefined;
        if (action === 'ping' && ping) return { bytes: frameMinecraftPacket(1, ping), close: true };
        const catalog = messages[context.route.locale];
        const localized = (text: MinecraftGatewayResponses['motd']) =>
          text?.[mode]?.[context.route.locale];
        if (action === 'status') {
          const motd = localized(responses.motd) ?? catalog[mode];
          const announced =
            clientProtocol !== undefined && clientProtocol >= 0
              ? clientProtocol
              : codec === 'netty'
                ? (responses.fallbackProtocol ?? version.protocolId)
                : (responses.legacyProtocol ?? version.protocolId);
          diagnostic('status', announced);
          const fields = {
            protocolId: announced,
            version: responses.versionName ?? version.release,
            motd,
            online: responses.onlinePlayers ?? 0,
            max: responses.maximumPlayers ?? 0,
          };
          return codec === 'netty'
            ? {
                bytes: textPacket({
                  version: { name: fields.version, protocol: announced },
                  players: { online: fields.online, max: fields.max, sample: [] },
                  description: formattingToComponents(motd),
                }),
                close: false,
              }
            : { bytes: legacyStatusPacket(legacyVariant, fields), close: true };
        }
        if (action === 'login' || action === 'incompatible' || action === 'transfer') {
          diagnostic(action);
          let text =
            action === 'login'
              ? (localized(responses.disconnect) ?? catalog[mode])
              : catalog[action];
          if (codec !== 'netty') {
            // Unversioned client handshakes use the already configured target as
            // a presentation hint; structured handshakes identify the client.
            if (
              codec === 'legacy-modified-utf8' ||
              (clientProtocol === undefined
                ? !minecraftLegacyMultiline(version.release)
                : clientProtocol <= 29)
            )
              text = (
                action === 'login' ? (localized(responses.legacyDisconnect) ?? text) : text
              ).replace(/\r\n|[\r\n]/g, responses.legacyLineSeparator ?? ' | ');
            return { bytes: legacyKickPacket(codec, text), close: true };
          }
          return { bytes: textPacket(formattingToComponents(text)), close: true };
        }
        return { close: true };
      },
    };
  };
  const probe = async (
    context: GatewayProtocolContext,
  ): Promise<{ ready: boolean; playerCount?: number }> => {
    const version = selected(context.route);
    if (!version) return { ready: false };
    if (version.family === 'legacy')
      return probeMinecraftLegacyStatus(context, version, {
        timeoutMs: probeTimeoutMs,
        maximumBytes: maxStatusBytes,
      });
    const deadline = performance.now() + probeTimeoutMs;
    // A running hint can precede Minecraft's first complete status response.
    // Retry only peer closure while waking, never malformed/mismatched responses,
    // and share the original deadline rather than extending the readiness budget.
    for (let attempt = 1; attempt <= 3; attempt++) {
      let closed = false;
      const remaining = Math.floor(deadline - performance.now());
      if (context.signal.aborted || remaining < 1) return { ready: false };
      const result = await probeMinecraftStatus(
        {
          ...context,
          onProbeDiagnostic: (event) => {
            if (event.stage === 'total') closed = event.reason === 'socket_closed';
            try {
              context.onProbeDiagnostic?.({ ...event, attempt });
            } catch {
              /* Diagnostics only. */
            }
          },
        },
        version,
        { timeoutMs: remaining, maximumBytes: maxStatusBytes },
      );
      if (result.ready || context.route.mode !== 'waking' || !closed || attempt === 3)
        return result;
      if (deadline - performance.now() <= 100) return result;
      try {
        await delay(100, undefined, { signal: context.signal });
      } catch {
        return { ready: false };
      }
    }
    return { ready: false };
  };
  return {
    id: 'minecraft-java',
    startupHint: 'provider_running',
    readinessSource: minecraftReadinessSource,
    supports: (route) => !!selected(route),
    createSession,
    // Minecraft is TCP-only and requires a per-connection status/ping dialogue.
    // Fail closed if invoked by an older stateless data plane.
    classify: () => ({ kind: 'unsupported' }),
    response: () => undefined,
    async observe(context) {
      const result = await probe(context);
      return { ...result, idle: result.ready && result.playerCount === 0 };
    },
    probeReadiness: probe,
    async probeIdle(context) {
      const result = await probe(context);
      return result.ready && result.playerCount !== undefined
        ? { idle: result.playerCount === 0, playerCount: result.playerCount }
        : { idle: false };
    },
  };
}
