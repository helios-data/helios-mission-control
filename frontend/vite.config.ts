import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// base='/static/' so hashed bundles are served by FastAPI at /static/* while
// admin.html is served by the backend route. /api, /ws, /brand are proxied to
// the backend during `npm run dev`.
export default defineConfig({
  base: "/static/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: resolve(__dirname, "admin.html"),
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
