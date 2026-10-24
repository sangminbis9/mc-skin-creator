import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Only development/preview uses public HTTP. Production uses a service binding.
  const proxy = { "/api": {
    target: env.API_PROXY_TARGET || "https://mc-skin-creator-api.mc-skin-creator-server.workers.dev",
    changeOrigin: true,
    timeout: 160_000,
    proxyTimeout: 155_000,
  } };
  return {
    plugins: [react()],
    server: { proxy, fs: { strict: true, allow: [process.cwd()] } },
    preview: { proxy },
    optimizeDeps: { entries: ["index.html"] },
    build: { rollupOptions: { output: { manualChunks: { three: ["three"] } } } },
  };
});
