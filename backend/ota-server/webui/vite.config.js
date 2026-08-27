import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output lands in ../static/app so the existing Dockerfile
// (COPY static ./static) ships it without any runtime build on the Pi.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: true,
    proxy: {
      "/api": { target: "http://192.168.1.175:8010", changeOrigin: true },
    },
  },
  build: {
    outDir: "../static/app",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
