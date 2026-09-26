import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
