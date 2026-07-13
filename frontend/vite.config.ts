import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import watermarkAMPlugin from "./vite-plugin-watermark-am";
export default defineConfig({
  plugins: [tailwindcss(), watermarkAMPlugin()],
  server: {
    // Proxy `/api/*` to the live backend at www.andrewmccall.uk. The `/api`
    // prefix is kept: the remote nginx strips it and forwards to the backend
    // (same rule as prod). Without this, Vite answers `/api/*` with the SPA
    // fallback (index.html).
    proxy: {
      "/api": {
        target: "https://www.andrewmccall.uk",
        changeOrigin: true,
      },
    },
  },
});
