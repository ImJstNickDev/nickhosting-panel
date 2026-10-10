import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { developmentNetwork } from './vite-network.js';

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.NH_WEB_CACHE_DIR,
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
