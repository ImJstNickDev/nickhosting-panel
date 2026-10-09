// Isolated synthetic transport fixture. No provider credentials, game files or real game protocol.
import { createSocket } from 'node:dgram';
import { connect, createServer } from 'node:net';

const mode = process.env.NH_FIXTURE_MODE;
const ports = (process.env.NH_FIXTURE_PORTS ?? '').split(',').map(Number);
if (
  !['game', 'node'].includes(mode) ||
  !ports.length ||
  ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) ||
  new Set(ports).size !== ports.length
)
  throw new Error('invalid fixture configuration');
const magic = Buffer.from('NH-NODE-PROBE-1:');
const challengeBytes = magic.length + 32;
const validChallenge = (bytes) =>
  bytes.length === challengeBytes && bytes.subarray(0, magic.length).equals(magic);
if (process.argv.includes('--health')) {
  const socket = connect(ports[0], '127.0.0.1');
  socket.setTimeout(1000, () => process.exit(1));
  socket.on('error', () => process.exit(1));
  socket.on('connect', () => {
    socket.destroy();
    process.exit(0);
  });
} else {
  const active = new Set();
  const services = [];
  for (const port of ports) {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      if (active.size >= 128) return socket.destroy();
      active.add(socket);
      socket.once('close', () => active.delete(socket));
      socket.setTimeout(15000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      if (mode === 'game') socket.pipe(socket);
      else {
        let bytes = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          if (bytes.length + chunk.length > challengeBytes) return socket.destroy();
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length === challengeBytes) {
            if (validChallenge(bytes)) socket.end(bytes);
            else socket.destroy();
          }
        });
        socket.on('end', () => socket.end());
      }
    });
    server.listen(port, '0.0.0.0');
    const udp = createSocket({ type: 'udp4', reuseAddr: false });
    udp.on('message', (bytes, remote) => {
      if ((mode === 'game' && bytes.length <= 32768) || validChallenge(bytes))
        udp.send(bytes, remote.port, remote.address, () => {});
    });
    udp.bind(port, '0.0.0.0');
    services.push(server, udp);
  }
  process.once('SIGTERM', () => {
    for (const socket of active) socket.destroy();
    for (const service of services) service.close();
  });
}
