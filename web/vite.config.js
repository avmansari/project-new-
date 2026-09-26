import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  // WalletConnect is lazy-loaded into its own (large) chunk only when a user picks it
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
