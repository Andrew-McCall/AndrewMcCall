import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import watermarkAMPlugin from "./vite-plugin-watermark-am";
export default defineConfig({
  plugins: [tailwindcss(), watermarkAMPlugin()],
  server: {
    // Mirror the production nginx rule: `/api/*` is stripped of its prefix and
    // forwarded to the backend (which serves `/password/{template}` etc.).
    // Without this, Vite answers `/api/*` with the SPA fallback (index.html).
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
