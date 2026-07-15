import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Multi-page build: /admin and /overlay are separate entry HTML files.
// base='/static/' so hashed bundles are served by FastAPI at /static/* while
// admin.html / overlay.html are served by the backend routes. /api, /ws, /brand
// are proxied to the backend during `npm run dev`.
export default defineConfig({
  base: "/static/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: resolve(__dirname, "admin.html"),
        overlay: resolve(__dirname, "overlay.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8090",
      "/brand": "http://127.0.0.1:8090",
      "/ws": { target: "ws://127.0.0.1:8090", ws: true },
    },
  },
});
