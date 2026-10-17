import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfjsAssets } from './pdfjs-assets.js';
import { developmentNetwork } from './vite-network.js';

export default defineConfig(({ command }) => ({
  plugins: [react(), pdfjsAssets()],
  resolve: {
    alias: [
      ...(command === 'serve'
        ? [
            {
              // The upstream browser distribution is already split ESM. Rebundling
              // every diagram layout (especially ELK) wastes dev-container memory.
              find: /^mermaid$/,
              replacement: fileURLToPath(
                new URL('./node_modules/mermaid/dist/mermaid.esm.min.mjs', import.meta.url),
              ),
            },
          ]
        : []),
      {
        // Markdown runs in Web Workers. This package's browser export uses a DOM
        // element; its default/worker implementation is pure character-entity data.
        find: /^decode-named-character-reference$/,
        replacement: fileURLToPath(
          new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url),
        ),
      },
      {
        find: /^rvfc-polyfill$/,
        replacement: fileURLToPath(
          new URL(
            './src/features/viewer-engine/builtin-viewers/native-video-frames.ts',
            import.meta.url,
          ),
        ),
      },
    ],
  },
  cacheDir: process.env.NH_WEB_CACHE_DIR,
  // Discover worker-only dependencies with the app. Late discovery rebuilds the
  // entire optimized graph and can exhaust the bounded development container.
  optimizeDeps: {
    entries: [
      'index.html',
      'src/features/viewer-engine/builtin-viewers/markdown/worker.ts',
      'src/features/viewer-engine/builtin-viewers/markdown/bibliography-worker.ts',
    ],
    include: ['mediabunny'],
    exclude: ['mermaid'],
  },
  server: {
    ...developmentNetwork(process.env),
    proxy: process.env.NH_WEB_API_PROXY
      ? Object.fromEntries(
          ['/api', '/v1'].map((path) => [
            path,
            {
              target: process.env.NH_WEB_API_PROXY,
              changeOrigin: false,
            },
          ]),
        )
      : undefined,
  },
  build: { sourcemap: false, license: { fileName: 'THIRD-PARTY-NOTICES.md' } },
}));
