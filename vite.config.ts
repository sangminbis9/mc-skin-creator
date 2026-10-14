import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Audit bundles are stored below the repository; only scan the real app.
  optimizeDeps: { entries: ["index.html"] },
});
