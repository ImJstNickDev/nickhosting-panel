import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import type { Plugin } from 'vite';

/** Version-matched PDF.js resources, never third-party CDN requests or arbitrary paths. */
export function pdfjsAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const files = new Map<string, string>();
  const inventory = async () => {
    if (files.size) return;
    for (const [source, target] of [
      ['cmaps', 'cmaps'],
      ['standard_fonts', 'standard_fonts'],
      ['wasm', 'wasm'],
      ['iccs', 'iccs'],
      ['web/images', 'images'],
    ] as const) {
      const directory = join(root, source);
      const walk = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const name = join(path, entry.name);
          if (entry.isDirectory()) await walk(name);
          else if (entry.isFile())
            files.set(`pdfjs/${target}/${relative(directory, name).replaceAll('\\', '/')}`, name);
        }
      };
      await walk(directory);
    }
    files.set('pdfjs/LICENSE', join(root, 'LICENSE'));
  };
  return {
    name: 'nickhosting-pdfjs-assets',
    async configureServer(server) {
      await inventory();
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const pathname = req.url?.split('?')[0]?.replace(/^\//, '') ?? '';
        const file = files.get(pathname);
        if (!file) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Content-Type',
          pathname.endsWith('.wasm')
            ? 'application/wasm'
            : pathname.endsWith('.svg')
              ? 'image/svg+xml'
              : 'application/octet-stream',
        );
        if (req.method === 'HEAD') return res.end();
        const stream = createReadStream(file);
        stream.on('error', () => {
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      });
    },
    async generateBundle() {
      await inventory();
      for (const [fileName, path] of files)
        this.emitFile({ type: 'asset', fileName, source: await readFile(path) });
    },
  };
}
