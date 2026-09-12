import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // dev-only: proxy to the supervisor so `npm run dev` works on the PC
  // while supervisor is running on 8642 (which proxies to Hermes on 8643).
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:8642",
      "/api": "http://127.0.0.1:8642",
      "/health": "http://127.0.0.1:8642",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});