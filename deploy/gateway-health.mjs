import { request } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Unix-only diagnostics: never opens a listener or prints a credential/response. */
export async function gatewayHealth(env = process.env) {
  const socketPath = env.NH_GATEWAY_DIAGNOSTICS_SOCKET;
  const token = env.NH_GATEWAY_CONTROL_TOKEN;
  if (
    typeof socketPath !== 'string' ||
    !socketPath.startsWith('/') ||
    socketPath.includes('\0') ||
    !/^[A-Za-z0-9_-]{43,512}$/.test(token ?? '')
  )
    return false;
  return new Promise((done) => {
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      done(ready);
    };
    const req = request(
      { socketPath, path: '/readyz', method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (response) => {
        if (response.statusCode !== 200) return finish(false);
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 16384) return finish(false);
          chunks.push(chunk);
        });
        response.on('error', () => finish(false));
        response.on('end', () => {
          try {
            const state = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(state.ready === true && state.controlAvailable === true);
          } catch {
            finish(false);
          }
        });
      },
    );
    // Overall deadline also bounds peers trickling bytes indefinitely.
    const timer = setTimeout(() => finish(false), 3000);
    req.on('error', () => finish(false));
    req.end();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!(await gatewayHealth())) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
