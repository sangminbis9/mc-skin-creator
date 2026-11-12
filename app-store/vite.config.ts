import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const api = env.VITE_API_BASE_URL || 'https://mc-skin-creator-api.mc-skin-creator-server.workers.dev';
  const url = new URL(api);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('VITE_API_BASE_URL must be an HTTPS origin without credentials, paths or query parameters.');
  }
  return {
    plugins: [react(), {
      name: 'native-content-security-policy',
      transformIndexHtml: () => [{ tag: 'meta', attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${url.origin} ${mode === 'development' ? 'ws://127.0.0.1:*' : ''}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`,
      }, injectTo: 'head' }],
    }],
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(url.origin) },
    build: { rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
  };
});
