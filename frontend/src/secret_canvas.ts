// Fullscreen Game of Life, rendered by wasm into an RGBA framebuffer that we
// blit each frame. Left-drag draws cells, right-drag erases; ten clean clicks
// (or Escape) leads to /secret.
//
// Live cells erode their tile's alpha over time, dissolving the board into
// the page rendered beneath the canvas. Holding left heals the ground under
// the cursor, holding right erodes it.

import { float_alert } from "./float_alert";

interface GameWasm {
  memory: WebAssembly.Memory;
  frame_ptr: () => number;
  tick: (width: number, height: number, dt: number) => void;
  reset: () => void;
  seed: (s: number) => void;
  paint: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    alive: number,
    radius: number,
  ) => void;
  hold: (x: number, y: number, mode: number) => void;
}

// Must match MAX_W / MAX_H in wasm/src/lib.rs.
const MAX_W = 1920;
const MAX_H = 1080;

const DRAW_RADIUS = 1;
const ERASE_RADIUS = 2;

let teardown: (() => void) | null = null;
let secret_counter = 10;

async function loadWasm(): Promise<GameWasm> {
  const res = await fetch("/canvas.wasm");
  try {
    const { instance } = await WebAssembly.instantiateStreaming(res.clone());
    return instance.exports as unknown as GameWasm;
  } catch {
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer());
    return instance.exports as unknown as GameWasm;
  }
}

export function hideGame(): void {
  teardown?.();
  teardown = null;
}

// Placeholder content the eroding canvas reveals — swap for real posts / CV.
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod " +
  "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim " +
  "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea " +
  "commodo consequat.";

function renderCards(app: HTMLElement): void {
  app.innerHTML = `
    <main class="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16 text-stone-300">
      ${[1, 2, 3]
        .map(
          (i) => `
      <article class="rounded-lg border border-stone-800 bg-stone-900 p-6">
        <h2 class="mb-2 text-lg font-bold text-lime-300">Post ${i}</h2>
        <p class="text-sm leading-relaxed">${LOREM}</p>
      </article>`,
        )
        .join("")}
    </main>`;
}

export default (app: HTMLElement) => {
  renderCards(app);
  if (teardown) return;

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:50;background:#0c0a09;overflow:hidden";

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "width:100%;height:100%;display:block;image-rendering:pixelated;touch-action:none";
  overlay.appendChild(canvas);

  let game: GameWasm | null = null;
  let stroke: { id: number; alive: number; x: number; y: number } | null = null;
  let downX = 0;
  let downY = 0;
  let dragged = false;

  const toFb = (ev: { clientX: number; clientY: number }) => ({
    x: (ev.clientX * canvas.width) / Math.max(canvas.clientWidth, 1),
    y: (ev.clientY * canvas.height) / Math.max(canvas.clientHeight, 1),
  });

  overlay.addEventListener("contextmenu", (ev) => ev.preventDefault());

  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 && ev.button !== 2) return;
    const { x, y } = toFb(ev);
    stroke = { id: ev.pointerId, alive: ev.button === 0 ? 1 : 0, x, y };
    downX = ev.clientX;
    downY = ev.clientY;
    dragged = false;
    overlay.setPointerCapture(ev.pointerId);
    game?.paint?.(
      x,
      y,
      x,
      y,
      stroke.alive,
      stroke.alive ? DRAW_RADIUS : ERASE_RADIUS,
    );
    game?.hold?.(x, y, stroke.alive ? 1 : 2);
  });

  overlay.addEventListener("pointermove", (ev) => {
    if (!stroke || ev.pointerId !== stroke.id) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) dragged = true;
    const points = ev.getCoalescedEvents?.() ?? [];
    for (const p of points.length > 0 ? points : [ev]) {
      const { x, y } = toFb(p);
      game?.paint?.(
        stroke.x,
        stroke.y,
        x,
        y,
        stroke.alive,
        stroke.alive ? DRAW_RADIUS : ERASE_RADIUS,
      );
      stroke.x = x;
      stroke.y = y;
    }
    game?.hold?.(stroke.x, stroke.y, stroke.alive ? 1 : 2);
  });

  const endStroke = (ev: PointerEvent) => {
    if (stroke && ev.pointerId === stroke.id) {
      stroke = null;
      game?.hold?.(0, 0, 0);
    }
  };
  overlay.addEventListener("pointerup", endStroke);
  overlay.addEventListener("pointercancel", endStroke);

  overlay.addEventListener("click", (ev) => {
    if (dragged) return;
    if (secret_counter < 6) {
      if (secret_counter < 1) return window.navigate("/secret");
      float_alert(
        ev.x,
        ev.y,
        `You are ${secret_counter} clicks away from becoming a nerd`,
      );
      setTimeout(() => {
        secret_counter += 1;
      }, 5000);
    }
    secret_counter -= 1;
  });

  document.body.appendChild(overlay);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    overlay.remove();
    return;
  }

  let running = true;
  let raf = 0;
  let w = 0;
  let h = 0;

  const resize = () => {
    w = Math.min(canvas.clientWidth, MAX_W);
    h = Math.min(canvas.clientHeight, MAX_H);
    canvas.width = w;
    canvas.height = h;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") window.navigate("/secret");
  };

  teardown = () => {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };

  window.addEventListener("resize", resize);
  window.addEventListener("keydown", onKey);
  resize();

  loadWasm()
    .then((wasm) => {
      if (!running) return;
      game = wasm;
      wasm.seed?.(Date.now() >>> 0);
      wasm.reset();
      const ptr = wasm.frame_ptr();
      let last = performance.now();
      let revealed = false;

      const loop = (now: number) => {
        if (!running) return;
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        if (w > 0 && h > 0) {
          wasm.tick(w, h, dt);
          const pixels = new Uint8ClampedArray(
            wasm.memory.buffer,
            ptr,
            w * h * 4,
          );
          ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
          if (!revealed) {
            // The canvas now covers the viewport, so drop the overlay's
            // backdrop: framebuffer transparency reveals the cards beneath.
            revealed = true;
            overlay.style.background = "transparent";
          }
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })
    .catch((err) => console.error("wasm game failed to load:", err));
};
