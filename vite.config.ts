import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import watermarkAMPlugin from "./vite-plugin-watermark-am";
export default defineConfig({
  plugins: [tailwindcss(), watermarkAMPlugin()],
});
