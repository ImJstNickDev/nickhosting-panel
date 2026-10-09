import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect, createServer, isIP, type Socket } from 'node:net';
import { DomainError } from '@nickhosting/core';

const magic = Buffer.from('NH-NODE-PROBE-1:');
const size = magic.length + 32;
function matches(input: Buffer) {
  return input.length === size && input.subarray(0, magic.length).equals(magic);
}
/** Proves a round trip to the EXACT backend address. It never probes a caller-
 * supplied alternate hostname or treats UDP send success as reachability. */
export async function probeNodeEndpoint(
  address: string,
  port: number,
  transport: 'tcp' | 'udp',
  timeoutMs: number,
): Promise<boolean> {
  if (
    !isIP(address) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    return false;
  const challenge = Buffer.concat([magic, randomBytes(32)]);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      close();
      resolve(ok);
    };
    let close = () => {};
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (transport === 'tcp') {
      const socket = connect({ host: address, port });
      close = () => socket.destroy();
      let received = Buffer.alloc(0);
      socket.on('connect', () => socket.write(challenge));
      socket.on('data', (chunk) => {
        if (received.length + chunk.length > size) return finish(false);
        received = Buffer.concat([received, chunk]);
        if (received.length === size) finish(timingSafeEqual(received, challenge));
      });
      socket.on('error', () => finish(false));
      socket.on('end', () => finish(false));
    } else {
      const socket = createSocket(isIP(address) === 6 ? 'udp6' : 'udp4');
      close = () => {
        try {
          socket.close();
        } catch {}
      };
      socket.on('error', () => finish(false));
      socket.on('message', (message) =>
        finish(message.length === size && timingSafeEqual(message, challenge)),
      );
      socket.connect(port, address, () =>
        socket.send(challenge, (error) => {
          if (error) finish(false);
        }),
      );
    }
  });
}
/** Small private health responder for explicitly approved fixture/deployment
 * endpoints. No invocation binds anything until startNodeProbe is called. */
export async function startNodeProbe(options: {
  address: string;
  port: number;
  transport: 'tcp' | 'udp';
  maxConnections?: number;
  timeoutMs?: number;
}) {
  if (
    !isIP(options.address) ||
    ['0.0.0.0', '::'].includes(options.address) ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new DomainError('configuration_invalid');
  const sockets = new Set<Socket>();
  if (options.transport === 'tcp') {
    const server = createServer((socket) => {
      if (sockets.size >= (options.maxConnections ?? 32)) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.setTimeout(options.timeoutMs ?? 1000, () => socket.destroy());
      let input = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (input.length + chunk.length > size) {
          socket.destroy();
          return;
        }
        input = Buffer.concat([input, chunk]);
        if (input.length === size) {
          if (matches(input)) socket.end(input);
          else socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(
        { host: options.address, port: options.port, exclusive: true, ipv6Only: true },
        () => {
          server.removeListener('error', reject);
          resolve();
        },
      );
    });
    server.on('error', () => {});
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new DomainError('internal_error');
    return {
      port: bound.port,
      async close() {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  const socket = createSocket({
    type: isIP(options.address) === 6 ? 'udp6' : 'udp4',
    reuseAddr: false,
    ...(isIP(options.address) === 6 ? { ipv6Only: true } : {}),
  });
  socket.on('message', (message, remote) => {
    if (matches(message)) socket.send(message, remote.port, remote.address, () => {});
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ address: options.address, port: options.port, exclusive: true }, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  });
  socket.on('error', () => {});
  return {
    port: socket.address().port,
    async close() {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}
