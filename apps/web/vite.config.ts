import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
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
