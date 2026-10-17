import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Development-only empty inventory, never a game provisioning implementation.
// This process has no provider forwarding, filesystem access or resource mutations.
const collections = new Set([
  '/api/application/nodes',
  '/api/application/nests',
  '/api/application/servers',
  '/api/application/users',
  '/api/client',
]);

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
    'x-nickhosting-dev-sandbox': 'empty-inventory-read-only',
    ...(status === 405 ? { allow: 'GET' } : {}),
  });
  response.end(JSON.stringify(body));
}

function error(response, status, code) {
  json(response, status, { errors: [{ code, status: String(status) }] });
}

export function createDevProviderHandler(token) {
  if (typeof token !== 'string' || !/^[!-~]{32,4096}$/.test(token))
    throw new Error('A development sandbox token of 32–4096 printable characters is required.');
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return (request, response) => {
    if (request.method !== 'GET') return error(response, 405, 'DevelopmentSandboxReadOnly');
    if (
      request.headers['transfer-encoding'] !== undefined ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
    )
      return error(response, 400, 'RequestBodyNotSupported');
    if (request.url === '/healthz')
      return json(response, 200, { status: 'ok', mode: 'empty-inventory-read-only' });

    const authorization = request.headers.authorization;
    let authorizationCount = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === 'authorization') authorizationCount++;
    }
    if (
      typeof authorization !== 'string' ||
      authorizationCount !== 1 ||
      !timingSafeEqual(createHash('sha256').update(authorization).digest(), expected)
    )
      return error(response, 403, 'DevelopmentSandboxUnauthorized');

    // Match the raw origin-form target: never normalize traversal, encoded slashes,
    // absolute URLs or alternative routes into an allowed inventory endpoint.
    const separator = request.url?.indexOf('?') ?? -1;
    const path = separator === -1 ? request.url : request.url.slice(0, separator);
    if (!collections.has(path)) return error(response, 404, 'NotFound');
    const query = new URLSearchParams(separator === -1 ? '' : request.url.slice(separator + 1));
    for (const key of query.keys()) {
      if (!['page', 'per_page'].includes(key) || query.getAll(key).length !== 1)
        return error(response, 400, 'InvalidPagination');
    }
    const page = query.get('page') ?? '1';
    const perPage = query.get('per_page') ?? '50';
    if (
      !/^[1-9]\d{0,3}$/.test(page) ||
      Number(page) > 1000 ||
      !/^[1-9]\d{0,2}$/.test(perPage) ||
      Number(perPage) > 100
    )
      return error(response, 400, 'InvalidPagination');
    return json(response, 200, {
      object: 'list',
      data: [],
      meta: {
        pagination: {
          total: 0,
          count: 0,
          per_page: Number(perPage),
          current_page: Number(page),
          total_pages: 1,
          links: {},
        },
      },
    });
  };
}

export function createDevProviderServer(token) {
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 1000,
      connectionsCheckingInterval: 1000,
    },
    createDevProviderHandler(token),
  );
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 50;
  server.setTimeout(5000, (socket) => socket.destroy());
  server.on('checkContinue', (_request, response) =>
    error(response, 405, 'DevelopmentSandboxReadOnly'),
  );
  const rejectTunnel = (_request, socket) => {
    socket.end(
      'HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      () => socket.destroy(),
    );
  };
  server.on('connect', rejectTunnel);
  server.on('upgrade', rejectTunnel);
  server.on('clientError', (failure, socket) => {
    if (!socket.writable) return socket.destroy();
    const status =
      failure.code === 'HPE_HEADER_OVERFLOW'
        ? '431 Request Header Fields Too Large'
        : '400 Bad Request';
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
      socket.destroy(),
    );
  });
  return server;
}

export async function stopDevProviderServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createDevProviderServer(process.env.NH_DEV_SANDBOX_TOKEN);
    server.on('error', () => {
      process.stderr.write('Development provider sandbox could not start.\n');
      process.exitCode = 1;
    });
    const stop = () => {
      void stopDevProviderServer(server);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.listen(9090, '0.0.0.0');
  } catch {
    process.stderr.write('Development provider sandbox requires a valid local token.\n');
    process.exitCode = 1;
  }
}
