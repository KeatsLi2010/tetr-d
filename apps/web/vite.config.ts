import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true
  },
  server: {
    port: 4174,
    proxy: {
      "/api": "http://127.0.0.1:4180",
      "/ws": {
        target: "ws://127.0.0.1:4180",
        ws: true
      }
    }
  }
});
