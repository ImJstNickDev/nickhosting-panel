import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import type { GatewayProtocolAdapter, GatewayProtocolContext } from '@nickhosting/game-sdk';

import { openworldSupportsGateway } from './version-policy.js';

const magic = Buffer.from('OWMU');

const maxStatusBytes = 8192;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function header(packet: Buffer, type: number) {
  return packet.length >= 26 && packet[16] === type && packet.subarray(17, 21).equals(magic);
}

export function openworldStatusRequest(nonce: Buffer) {
  if (nonce.length !== 4) throw new RangeError('Expected a four-byte query ID');
  const packet = Buffer.alloc(1040);
  packet[0] = 1;
  packet[1] = 1;
  packet[16] = 7;
  magic.copy(packet, 17);
  packet[21] = 1;
  nonce.copy(packet, 22);
  packet.writeUInt16LE(0xffff, 26);
  return packet;
}

function statusRequest(packet: Buffer) {
  // The client uses the same query for metadata and individual icon fragments.
  return packet.length === 1040 && header(packet, 7) && packet[21] === 1;
}

export function readOpenworldStatus(packet: Buffer, nonce: Buffer) {
  if (
    packet.length < 44 ||
    packet.length > maxStatusBytes ||
    !header(packet, 8) ||
    !packet.subarray(21, 25).equals(nonce)
  )
    return undefined;
  const players = packet.readUInt16LE(26);
  const slots = packet.readUInt16LE(28);
  if (slots === 0 || slots > 1000 || players > slots) return undefined;
  // Bytes 30–39 describe additional server properties; the join and readiness
  // paths do not depend on their undocumented meaning.
  let cursor = 40;
  const field = (prefix: 1 | 2) => {
    const length = prefix === 1 ? packet.readUInt8(cursor) : packet.readUInt16LE(cursor);
    cursor += prefix;
    if (cursor + length > packet.length) throw new RangeError('Incomplete status field');
    const value = utf8.decode(packet.subarray(cursor, cursor + length));
    cursor += length;
    return value;
  };
  try {
    const name = field(1);
    const description = field(2);
    const version = field(1);
    return { players, slots, name, description, version };
  } catch {
    return undefined;
  }
}

export function observeOpenworld(context: GatewayProtocolContext): Promise<{
  ready: boolean;
  playerCount?: number;
}> {
  const { route, signal } = context;
  if (signal.aborted || !openworldGatewayAdapter.supports(route))
    return Promise.resolve({ ready: false });
  const nonce = randomBytes(4);
  const socket = createSocket(isIP(route.backend.address) === 6 ? 'udp6' : 'udp4');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (playerCount?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      socket.close();
      resolve(playerCount === undefined ? { ready: false } : { ready: true, playerCount });
    };
    const cancel = () => finish();
    const timeout = setTimeout(cancel, 1500);
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('error', cancel);
    socket.on('message', (bytes) => {
      const status = readOpenworldStatus(bytes, nonce);
      if (status && status.version === route.protocol?.gameVersion) finish(status.players);
    });
    try {
      socket.connect(route.backend.port, route.backend.address, () => {
        if (!settled)
          socket.send(openworldStatusRequest(nonce), (error) => {
            if (error) cancel();
          });
      });
    } catch {
      cancel();
    }
  });
}

export const openworldGatewayAdapter: GatewayProtocolAdapter = {
  id: 'openworld',
  startupHint: 'provider_running',
  supports: (route) =>
    route.protocol?.handlerId === 'openworld' &&
    openworldSupportsGateway(route.protocol.gameVersion) &&
    route.protocol.role === 'game' &&
    route.public.transport === 'udp',
  isStatusDatagram(input, direction) {
    const packet = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    return direction === 'client' ? statusRequest(packet) : header(packet, 8) || header(packet, 9);
  },
  classify(input) {
    const packet = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    return { kind: statusRequest(packet) ? 'status' : 'ignore' };
  },
  // An observed initial handshake is not proof of a player's intent or identity.
  // Keep wake manual until client retry/timeout behavior has been established.
  response: () => undefined,
  observe: observeOpenworld,
  probeReadiness: observeOpenworld,
};
export const gatewayProtocols = [openworldGatewayAdapter];
