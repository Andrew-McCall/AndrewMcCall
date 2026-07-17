// Fullscreen Game of Life, rendered by wasm into an RGBA framebuffer that we
// blit each frame. Left-drag draws cells, right-drag erases; ten clean clicks
// (or Escape) leads to /secret.
//
// Live cells erode their tile's alpha over time, dissolving the board into
// the home page rendered beneath the canvas. Holding left erodes the ground
// under the cursor, holding right repairs it. The overlay is fixed over the
// whole viewport while the page scrolls beneath it; a click landing on a
// see-through pixel is forwarded to whatever link or button it revealed.

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
const MAX_W = 2560;
const MAX_H = 1440;

const DRAW_RADIUS = 1;
const ERASE_RADIUS = 2;

// Framebuffer alpha below which a click falls through to the page beneath.
const CLICK_THROUGH_ALPHA = 64;

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

export default () => {
  if (teardown) return;

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:50;background:#0c0a09;overflow:hidden";

  const canvas = document.createElement("canvas");
  // pan-y keeps vertical touch swipes scrolling the page beneath; horizontal
  // strokes still draw.
  canvas.style.cssText =
    "width:100%;height:100%;display:block;image-rendering:pixelated;touch-action:pan-y";
  overlay.appendChild(canvas);

  let game: GameWasm | null = null;
  let framePtr = 0;
  let stroke: { id: number; alive: number; x: number; y: number } | null = null;
  let downX = 0;
  let downY = 0;
  let dragged = false;

  const toFb = (ev: { clientX: number; clientY: number }) => ({
    x: (ev.clientX * canvas.width) / Math.max(canvas.clientWidth, 1),
    y: (ev.clientY * canvas.height) / Math.max(canvas.clientHeight, 1),
  });

  // Alpha of the last rendered frame at a client position; opaque if unknown.
  const alphaAt = (ev: { clientX: number; clientY: number }): number => {
    if (!game || framePtr === 0 || w === 0 || h === 0) return 255;
    const { x, y } = toFb(ev);
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= w || py >= h) return 255;
    const pixels = new Uint8ClampedArray(game.memory.buffer, framePtr, w * h * 4);
    return pixels[(py * w + px) * 4 + 3];
  };

  // Hand a click on see-through ground to the revealed element beneath.
  const forwardClick = (ev: MouseEvent): boolean => {
    overlay.style.pointerEvents = "none";
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    overlay.style.pointerEvents = "";
    const target = el?.closest("a, button");
    if (target instanceof HTMLElement) {
      target.click();
      return true;
    }
    return false;
  };

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
    game?.hold?.(x, y, stroke.alive ? 2 : 1);
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
    game?.hold?.(stroke.x, stroke.y, stroke.alive ? 2 : 1);
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
    if (alphaAt(ev) < CLICK_THROUGH_ALPHA && forwardClick(ev)) return;
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
      framePtr = wasm.frame_ptr();
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
            framePtr,
            w * h * 4,
          );
          ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
          if (!revealed) {
            // The canvas now covers the viewport, so drop the overlay's
            // backdrop: framebuffer transparency reveals the page beneath.
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
