import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfjsAssets } from './pdfjs-assets.js';
import { developmentNetwork } from './vite-network.js';

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  resolve: {
    alias: [
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
  // Worker-only imports escape the initial app scan. Include the decoder now
  // instead of rebuilding the dependency bundle when Wave first opens.
  optimizeDeps: { include: ['mediabunny'] },
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
});
