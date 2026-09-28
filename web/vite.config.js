import { defineConfig } from "vite";
import { resolve } from "node:path";

// @pow/shared normally resolves through the npm workspace link (node_modules/@pow/shared -> ../shared).
// That link breaks when a project folder is copied to another PC with its node_modules, so point
// straight at the folder as well.
const shared = resolve(__dirname, "../shared");

export default defineConfig({
  worker: { format: "es" },
  resolve: {
    alias: [
      { find: /^@pow\/shared$/, replacement: resolve(shared, "pow-core.js") },
      { find: /^@pow\/shared\/gpu-name$/, replacement: resolve(shared, "gpu-name.js") },
      { find: /^@pow\/shared\/keccak-wgsl$/, replacement: resolve(shared, "keccak-wgsl.js") },
    ],
  },
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
