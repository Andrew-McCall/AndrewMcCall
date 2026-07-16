// Fullscreen WASM Game of Life — the front page.
//
// The sim runs on a fixed, viewport-filling <canvas> layered above the SPA,
// mounted on <body> (not inside #app). It autoplays: the wasm module spells
// the name in live cells, holds, then evolves it while meteor streaks seed
// new life. Hiding it tears everything down and reveals the SPA underneath.
//
// The wasm module owns a fixed RGBA framebuffer in linear memory: we call
// `tick(w, h, dt)` each frame to advance + render, then blit with putImageData.
//
// The grid is drawable: left-drag births cells, right-drag kills them. Each
// pointer event paints an interpolated segment from the previous point inside
// the wasm (plus coalesced events where supported), so fast drags leave a
// solid line instead of dots.
//
// This page also inherits the front page's easter egg: ten clicks anywhere
// (or Escape) leads to /secret. Drags don't count — only clean clicks.

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
}

// Must match MAX_W / MAX_H in wasm/src/lib.rs — the framebuffer's hard cap.
const MAX_W = 1920;
const MAX_H = 1080;

let teardown: (() => void) | null = null;
let secret_counter = 10;

async function loadWasm(): Promise<GameWasm> {
  const res = await fetch("/canvas.wasm");
  try {
    // Fast path — requires the host to serve `application/wasm`.
    const { instance } = await WebAssembly.instantiateStreaming(res.clone());
    return instance.exports as unknown as GameWasm;
  } catch {
    // Fallback for static hosts that mislabel the wasm MIME type.
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer());
    return instance.exports as unknown as GameWasm;
  }
}

/// Tear down the overlay and stop the loop. Idempotent; safe to call when the
/// sim isn't running. The router calls this on any navigation away.
export function hideGame(): void {
  teardown?.();
  teardown = null;
}

export default (app: HTMLElement) => {
  // The canvas spells the name in cells; keep it in the document proper for
  // screen readers and crawlers.
  app.innerHTML = `<h1 class="sr-only">Andrew David McCall</h1>`;
  if (teardown) return; // already running

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:50;background:#0c0a09;overflow:hidden";

  const canvas = document.createElement("canvas");
  // touch-action:none so pointermove fires for touch drags instead of the
  // browser claiming them as scroll gestures.
  canvas.style.cssText =
    "width:100%;height:100%;display:block;image-rendering:pixelated;touch-action:none";
  overlay.appendChild(canvas);

  // Populated once the wasm finishes loading; pointer handlers no-op until then.
  let game: GameWasm | null = null;

  // Drawing. One stroke at a time: left button (or touch) births cells,
  // right button kills — with a slightly wider brush, like any eraser.
  // Client coords are mapped to framebuffer pixels — they differ when the
  // viewport exceeds the wasm's max resolution. Radii are in cells.
  const DRAW_RADIUS = 1;
  const ERASE_RADIUS = 2;
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
    game?.paint?.(x, y, x, y, stroke.alive, stroke.alive ? DRAW_RADIUS : ERASE_RADIUS);
  });

  overlay.addEventListener("pointermove", (ev) => {
    if (!stroke || ev.pointerId !== stroke.id) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) dragged = true;
    // Coalesced events recover the full-rate pointer path the browser folded
    // into this one event — with the wasm interpolating between each pair,
    // even violent drags paint a consistent line.
    const points = ev.getCoalescedEvents?.() ?? [];
    for (const p of points.length > 0 ? points : [ev]) {
      const { x, y } = toFb(p);
      game?.paint?.(stroke.x, stroke.y, x, y, stroke.alive, stroke.alive ? DRAW_RADIUS : ERASE_RADIUS);
      stroke.x = x;
      stroke.y = y;
    }
  });

  const endStroke = (ev: PointerEvent) => {
    if (stroke && ev.pointerId === stroke.id) stroke = null;
  };
  overlay.addEventListener("pointerup", endStroke);
  overlay.addEventListener("pointercancel", endStroke);

  // Easter egg carried over from the old static front page: ten clicks
  // anywhere and you're a nerd. float_alert mounts on <body> at z-9999,
  // safely above this overlay.
  overlay.addEventListener("click", (ev) => {
    if (dragged) return; // that was a drawing stroke, not a click
    if (secret_counter < 6) {
      if (secret_counter < 1) return window.navigate("/secret");
      float_alert(
        ev.x,
        ev.y,
        `You are ${secret_counter} clicks away from becoming a nerd`,
      );
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
    if (e.key === "Escape") window.navigate("/secret"); // router calls hideGame
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
      if (!running) return; // hidden before wasm finished loading
      game = wasm;
      wasm.seed?.(Date.now() >>> 0);
      wasm.reset();
      const ptr = wasm.frame_ptr();
      let last = performance.now();

      const loop = (now: number) => {
        if (!running) return;
        const dt = Math.min((now - last) / 1000, 0.05); // clamp long stalls
        last = now;
        if (w > 0 && h > 0) {
          wasm.tick(w, h, dt);
          // Re-view each frame: the buffer can detach if memory ever grows.
          const pixels = new Uint8ClampedArray(wasm.memory.buffer, ptr, w * h * 4);
          ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })
    .catch((err) => {
      console.error("wasm game failed to load:", err);
      if (!running) return;
      // The front page must never render blank: drop the overlay and fall
      // back to the name as plain (styled) text.
      hideGame();
      app.innerHTML = `<div class="flex justify-center items-center min-h-screen">
  <h1 class="px-1 italic text-7xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
    Andrew David McCall
  </h1>
</div>`;
    });
};
