import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class PreparationError extends Error {}

export function parseDevPreparationArgs(args) {
  let ownerApproved = false;
  let publicUrl;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--owner-approved' && !ownerApproved) ownerApproved = true;
    else if (args[index] === '--public-url' && publicUrl === undefined && args[index + 1])
      publicUrl = args[++index];
    else throw new PreparationError('Only --owner-approved and --public-url are supported.');
  }
  if (!ownerApproved) throw new PreparationError('Explicit --owner-approved is required.');
  if (!publicUrl) throw new PreparationError('An explicit --public-url is required.');
  return { ownerApproved, publicUrl };
}

function publicOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (value !== url.origin && value !== `${url.origin}/`)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new PreparationError('--public-url must be an exact HTTPS origin without credentials.');
  }
}

async function existing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertDirectoryChain(path) {
  if (path !== resolve(path)) throw new PreparationError('Preparation paths must be canonical.');
  const filesystemRoot = parse(path).root;
  let current = filesystemRoot;
  for (const component of path.slice(filesystemRoot.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new PreparationError('Refusing a symlink or non-directory in the preparation path.');
  }
}

async function writeExclusive(path, contents, mode) {
  await assertDirectoryChain(dirname(path));
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await file.chmod(mode);
    await file.writeFile(contents, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

function mailCertificate() {
  try {
    // Private key and certificate stay in captured memory until exclusively written
    // below. Never inherit OpenSSL configuration, print its output or use a shell.
    const output = execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-noenc',
        '-days',
        '365',
        '-subj',
        '/CN=mailpit',
        '-addext',
        'subjectAltName=DNS:mailpit',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
        '-addext',
        'extendedKeyUsage=serverAuth',
        '-keyout',
        '-',
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, OPENSSL_CONF: '/dev/null' },
        timeout: 30_000,
        maxBuffer: 65_536,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const key = output.match(
      /-----BEGIN[ ]PRIVATE[ ]KEY-----[\s\S]*?-----END[ ]PRIVATE[ ]KEY-----/g,
    );
    const cert = output.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (key?.length !== 1 || cert?.length !== 1) throw new Error();
    const certificate = new X509Certificate(cert[0]);
    if (
      !certificate.checkHost('mailpit') ||
      !certificate.checkPrivateKey(createPrivateKey(key[0])) ||
      !certificate.verify(certificate.publicKey)
    )
      throw new Error();
    return { key: `${key[0]}\n`, cert: `${cert[0]}\n` };
  } catch {
    throw new PreparationError(
      'OpenSSL certificate generation failed; no credentials were printed.',
    );
  }
}

/** Future Owner-approved preparation only. Never starts services or seeds accounts. */
export async function prepareDevelopmentEnvironment({ root, ownerApproved, publicUrl }) {
  if (ownerApproved !== true) throw new PreparationError('Explicit --owner-approved is required.');
  const origin = publicOrigin(publicUrl);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0)
    throw new PreparationError(
      'Run preparation as the non-root development user; do not use sudo.',
    );
  let writing = false;
  try {
    await assertDirectoryChain(root);
    const envPath = join(root, '.env.dev.local');
    const mountRoot = join(root, 'mountdata');
    const devRoot = join(mountRoot, 'dev');
    if (await existing(envPath))
      throw new PreparationError(
        'Existing .env.dev.local is preserved; preparation will not overwrite it.',
      );
    const mountInfo = await existing(mountRoot);
    if (mountInfo) await assertDirectoryChain(mountRoot);
    const devInfo = await existing(devRoot);
    if (devInfo) {
      await assertDirectoryChain(devRoot);
      if ((await readdir(devRoot)).length !== 0)
        throw new PreparationError(
          'Existing mountdata/dev data is preserved; the directory must be empty.',
        );
    }
    await access(root, constants.W_OK | constants.X_OK);
    await access(devInfo ? devRoot : mountInfo ? mountRoot : root, constants.W_OK | constants.X_OK);

    const tls = mailCertificate();
    const secrets = Object.fromEntries(
      [
        'DB_PASSWORD',
        'REDIS_PASSWORD',
        'AUTH_SECRET',
        'SETUP_TOKEN',
        'SANDBOX_TOKEN',
        'MAIL_PASSWORD',
      ].map((name) => [`NH_DEV_${name}`, randomBytes(32).toString('base64url')]),
    );
    secrets.NH_DEV_MASTER_KEY = randomBytes(32).toString('base64');
    const fields = {
      NH_DEV_ENV_FILE: '.env.dev.local',
      NH_DEV_PUBLIC_URL: origin,
      NH_DEV_UID: String(uid),
      NH_DEV_GID: String(gid),
      ...secrets,
    };

    writing = true;
    if (!mountInfo) await mkdir(mountRoot, { mode: 0o700 });
    await assertDirectoryChain(mountRoot);
    if (!devInfo) await mkdir(devRoot, { mode: 0o700 });
    // Each creation is exclusive. Never reuse a child created by an earlier run.
    for (const directory of [
      'postgres',
      'redis',
      'app',
      'app/content',
      'app/sources',
      'mail',
      'mail-tls',
    ]) {
      const path = join(devRoot, directory);
      await assertDirectoryChain(dirname(path));
      await mkdir(path, { mode: 0o700 });
    }
    await writeExclusive(join(devRoot, 'mail-tls/key.pem'), tls.key, 0o600);
    await writeExclusive(join(devRoot, 'mail-tls/cert.pem'), tls.cert, 0o644);
    await writeExclusive(
      join(devRoot, 'mail-tls/smtp-auth'),
      `nickhosting-dev:${secrets.NH_DEV_MAIL_PASSWORD}\n`,
      0o600,
    );
    await writeExclusive(
      envPath,
      '# Development only. Generated locally; never commit or reuse for production.\n' +
        Object.entries(fields)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(''),
      0o600,
    );
    return { envPath, devRoot, uid, gid };
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    if (error.code === 'EACCES' || error.code === 'EPERM')
      throw new PreparationError(
        'Directory permission denied. Request separately approved scoped directory preparation; do not use sudo or change the mountdata parent.' +
          (writing ? ' Partial development files may remain; inspect them before retrying.' : ''),
      );
    throw new PreparationError(
      'Development preparation failed without overwriting existing state.' +
        (writing ? ' Partial development files may remain; inspect them before retrying.' : ''),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await prepareDevelopmentEnvironment({
      root: fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''),
      ...parseDevPreparationArgs(process.argv.slice(2)),
    });
    process.stdout.write(
      'Prepared development-only files. No containers or network resources were created.\n',
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof PreparationError ? error.message : 'Development preparation failed.'}\n`,
    );
    process.exitCode = 1;
  }
}
