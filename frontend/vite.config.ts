import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import watermarkAMPlugin from "./vite-plugin-watermark-am";
// Where `npm run dev` sends `/api/*`. Defaults to the live site, so the plain
// `npm run dev` workflow is unchanged — but note that means the dev server reads
// and writes PRODUCTION data. Point it at a local backend before testing
// anything that writes:
//
//   VITE_API_TARGET=http://127.0.0.1:3000 npm run dev
//
// The remote target needs `changeOrigin` (nginx routes on Host); a local one
// must not have it, or the backend sees the wrong Host.
const apiTarget = process.env.VITE_API_TARGET ?? "https://www.andrewmccall.uk";
const isRemote = apiTarget.startsWith("https://");

export default defineConfig({
  plugins: [tailwindcss(), watermarkAMPlugin()],
  server: {
    // Proxy `/api/*` to the backend. Without this, Vite answers `/api/*` with
    // the SPA fallback (index.html).
    //
    // The prefix is only kept for the remote target, where nginx strips it
    // before forwarding. A local backend has no nginx in front and serves
    // `/health`, not `/api/health`, so the prefix is stripped here instead —
    // otherwise every single API call 404s.
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: isRemote,
        rewrite: isRemote ? undefined : (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
