// Regenerate public/nojs.png — the <noscript> snapshot of the front page.
// Runs the real wasm for one frame and converts via sips (macOS).
// Usage: node scripts/nojs-image.mjs
import { readFile, writeFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const W = 1920;
const H = 1080;

const { instance } = await WebAssembly.instantiate(
  await readFile(`${root}/public/canvas.wasm`),
);
const { memory, frame_ptr, tick, reset, seed } = instance.exports;
seed(1);
reset();
tick(W, H, 0.01);

const fb = new Uint8Array(memory.buffer, frame_ptr(), W * H * 4);
const rgb = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) {
  rgb[i * 3] = fb[i * 4];
  rgb[i * 3 + 1] = fb[i * 4 + 1];
  rgb[i * 3 + 2] = fb[i * 4 + 2];
}

const ppm = `${root}/public/nojs.ppm`;
await writeFile(ppm, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), rgb]));
execFileSync("sips", ["-s", "format", "png", ppm, "--out", `${root}/public/nojs.png`], {
  stdio: "ignore",
});
await unlink(ppm);
console.log("wrote public/nojs.png");
