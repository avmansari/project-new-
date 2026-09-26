import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  worker: { format: "es" },
  // WalletConnect is lazy-loaded into its own (large) chunk only when a user picks it
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
        admin: resolve(__dirname, "admin.html"),
        terms: resolve(__dirname, "terms.html"),
      },
    },
  },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
