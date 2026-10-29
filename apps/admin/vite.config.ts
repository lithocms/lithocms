import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Dev only: the dev compose stack proxies localhost (the admin origin) to this server and
  // /api/*, /mcp and /.well-known/* to the app.
  server: {
    host: true,
    allowedHosts: ['localhost'],
    hmr: { clientPort: 8080 },
  },
});
