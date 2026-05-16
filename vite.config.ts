import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageRoot,
  plugins: [react()],
  server: {
    port: 4173,
    proxy: {
      "/api": {
        target: "http://localhost:4312",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: path.join(packageRoot, "web-dist")
  }
});
