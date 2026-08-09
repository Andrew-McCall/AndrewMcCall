import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so the test run doesn't pull in the
// Tailwind and watermark plugins or the dev proxy — none of which the unit
// tests need. The code under test is pure string manipulation, so `node` is the
// right environment: no jsdom dependency.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
