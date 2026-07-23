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
  fade: (d: number) => void;
  set_decay: (pct: number) => void;
}

// Must match MAX_W / MAX_H in wasm/src/lib.rs.
const MAX_W = 2560;
const MAX_H = 1440;

const DRAW_RADIUS = 1;
const ERASE_RADIUS = 2;

// A soft glow layer sits under the crisp pixels: the framebuffer downsampled
// 3x (a 3x3 pixelisation) then CSS-blurred, so live cells bleed a halo behind
// the sharp board and eroded edges feather into the page beneath.
const BLUR_SCALE = 3;
const BLUR_PX = 5;
const BLUR_ALPHA = 0.6;

// The "static" toggle veils the board in chunky green noise, rendered at 1/3
// res and scaled up pixelated, screen-blended so it reads as a glow over the
// live cells. While it's on, natural erosion runs at STATIC_DECAY_PCT.
const STATIC_SCALE = 3;
const STATIC_ALPHA = 0.4;
const STATIC_DECAY_PCT = 50;

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

  // Under-layer: a low-res copy of the framebuffer, blurred, showing through
  // wherever the crisp layer above has any alpha.
  const blur = document.createElement("canvas");
  blur.style.cssText =
    `position:absolute;inset:0;width:100%;height:100%;display:block;` +
    `image-rendering:pixelated;pointer-events:none;` +
    `filter:blur(${BLUR_PX}px);opacity:${BLUR_ALPHA}`;
  overlay.appendChild(blur);

  const canvas = document.createElement("canvas");
  // pan-y keeps vertical touch swipes scrolling the page beneath; horizontal
  // strokes still draw.
  canvas.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:pixelated;touch-action:pan-y";
  overlay.appendChild(canvas);

  // Static veil, above the crisp board. Hidden until the static button is on.
  const stat = document.createElement("canvas");
  stat.style.cssText =
    `position:absolute;inset:0;width:100%;height:100%;display:none;` +
    `image-rendering:pixelated;pointer-events:none;` +
    `opacity:${STATIC_ALPHA};mix-blend-mode:screen`;
  overlay.appendChild(stat);
  let staticOn = false;

  // Controls revealed *beneath* the board (lower z-index), clicked through the
  // eroded ground by the same forwarding as any other link. Reset re-covers the
  // page with a fresh board; static toggles the noise veil + halved erosion.
  const controls = document.createElement("div");
  controls.style.cssText =
    "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:40;" +
    "display:flex;gap:10px";
  const mkBtn = (label: string) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "padding:6px 14px;font:12px ui-monospace,monospace;letter-spacing:.08em;" +
      "color:#4ade80;background:rgba(12,10,9,.6);border:1px solid #14532d;cursor:pointer";
    return b;
  };
  const resetBtn = mkBtn("↺ reset");
  const staticBtn = mkBtn("▓ static");
  controls.append(resetBtn, staticBtn);
  document.body.appendChild(controls);

  resetBtn.addEventListener("click", () => game?.reset?.());
  staticBtn.addEventListener("click", () => {
    staticOn = !staticOn;
    stat.style.display = staticOn ? "block" : "none";
    game?.set_decay?.(staticOn ? STATIC_DECAY_PCT : 100);
    staticBtn.style.borderColor = staticOn ? "#4ade80" : "#14532d";
    staticBtn.style.color = staticOn ? "#bef264" : "#4ade80";
  });

  // First-visit hint: the front page lives *beneath* this board, so a newcomer
  // needs telling how to reveal it. It sits under the canvas (lower z-index), so
  // the eroding board uncovers it like any other page content, and it clears on
  // the first click, staying gone for the rest of the session.
  let hint: HTMLDivElement | null = null;
  if (!sessionStorage.getItem("home-hint-seen")) {
    hint = document.createElement("div");
    hint.textContent = "drag to erode · scroll to fade · a page hides beneath";
    hint.style.cssText =
      "position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:40;" +
      "font:12px ui-monospace,monospace;letter-spacing:.08em;color:#4ade80;" +
      "white-space:nowrap;pointer-events:none;opacity:0.85;transition:opacity .5s ease";
    document.body.appendChild(hint);
  }
  const dismissHint = () => {
    if (!hint) return;
    sessionStorage.setItem("home-hint-seen", "1");
    const el = hint;
    hint = null;
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 500);
  };

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
    const pixels = new Uint8ClampedArray(
      game.memory.buffer,
      framePtr,
      w * h * 4,
    );
    return pixels[(py * w + px) * 4 + 3];
  };

  // The page element visible beneath the overlay at a client position.
  const elementBeneath = (ev: { clientX: number; clientY: number }) => {
    overlay.style.pointerEvents = "none";
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    overlay.style.pointerEvents = "";
    return el;
  };

  // Hand a click on see-through ground to the revealed element beneath.
  const forwardClick = (ev: MouseEvent): boolean => {
    const target = elementBeneath(ev)?.closest("a, button");
    if (target instanceof HTMLElement) {
      target.click();
      return true;
    }
    return false;
  };

  // The overlay eats CSS :hover, so forward the pointer position to the profile
  // photo when the cursor rests on see-through ground above it; it uses the
  // distance from its centre to drive the green tint and pixelation. The same
  // pass gives the overlay a pointer cursor over any revealed link, so eroded
  // ground feels clickable the way the page beneath would.
  let hovered: Element | null = null;
  const syncHover = (ev: { clientX: number; clientY: number } | null) => {
    const beneath =
      ev && !stroke && alphaAt(ev) < CLICK_THROUGH_ALPHA
        ? elementBeneath(ev)
        : null;
    overlay.style.cursor = beneath?.closest("a, button, [data-url]")
      ? "pointer"
      : "";
    const el = beneath?.closest(".profile-photo") ?? null;
    if (el !== hovered) {
      hovered?.dispatchEvent(new CustomEvent("profilehover", { detail: null }));
      hovered = el;
    }
    if (el && ev)
      el.dispatchEvent(
        new CustomEvent("profilehover", {
          detail: { x: ev.clientX, y: ev.clientY },
        }),
      );
  };

  overlay.addEventListener("contextmenu", (ev) => ev.preventDefault());

  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 && ev.button !== 2) return;
    dismissHint();
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
    syncHover(ev);
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
  overlay.addEventListener("pointerleave", () => syncHover(null));

  // Wheel fades the whole board instead of scrolling: up restores 12 alpha
  // per page of travel, down erodes 6. Fractional pages accumulate.
  let fadeAcc = 0;
  overlay.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const pageH = Math.max(window.innerHeight, 1);
      const px =
        ev.deltaMode === 2
          ? ev.deltaY * pageH
          : ev.deltaMode === 1
            ? ev.deltaY * 40
            : ev.deltaY;
      fadeAcc += (-px / pageH) * (px < 0 ? 12 : 6);
      const d = Math.trunc(fadeAcc);
      if (d !== 0) {
        fadeAcc -= d;
        game?.fade?.(d);
      }
    },
    { passive: false },
  );

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

  // Scroll is repurposed for fading while the game is up, so hide the bar.
  const scrollbarHide = document.createElement("style");
  scrollbarHide.textContent =
    "html{scrollbar-width:none}html::-webkit-scrollbar{display:none}";
  document.head.appendChild(scrollbarHide);

  document.body.appendChild(overlay);

  const ctx = canvas.getContext("2d");
  const bctx = blur.getContext("2d");
  const sctx = stat.getContext("2d");
  if (!ctx || !bctx || !sctx) {
    overlay.remove();
    controls.remove();
    return;
  }
  bctx.imageSmoothingEnabled = true; // average each 3x3 block on downsample

  let running = true;
  let raf = 0;
  let w = 0;
  let h = 0;
  // Reused each frame the static veil is on, so a 60fps redraw allocates nothing.
  let noise: ImageData | null = null;

  const resize = () => {
    w = Math.min(canvas.clientWidth, MAX_W);
    h = Math.min(canvas.clientHeight, MAX_H);
    canvas.width = w;
    canvas.height = h;
    blur.width = Math.max(Math.ceil(w / BLUR_SCALE), 1);
    blur.height = Math.max(Math.ceil(h / BLUR_SCALE), 1);
    bctx.imageSmoothingEnabled = true; // reset: resizing clears the context
    stat.width = Math.max(Math.ceil(w / STATIC_SCALE), 1);
    stat.height = Math.max(Math.ceil(h / STATIC_SCALE), 1);
    noise = sctx.createImageData(stat.width, stat.height);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") window.navigate("/secret");
  };

  teardown = () => {
    running = false;
    syncHover(null);
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", onKey);
    scrollbarHide.remove();
    hint?.remove();
    controls.remove();
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
          // Downsample the crisp frame into the blur layer (3x3 -> 1px),
          // carrying its alpha so eroded ground stays see-through.
          bctx.clearRect(0, 0, blur.width, blur.height);
          bctx.drawImage(canvas, 0, 0, blur.width, blur.height);
          if (staticOn && noise) {
            // Fresh green-tinted noise every frame — chunky once scaled up.
            const d = noise.data;
            for (let i = 0; i < d.length; i += 4) {
              const v = (Math.random() * 255) | 0;
              d[i] = v >> 2; // low red
              d[i + 1] = v; // bright green
              d[i + 2] = v >> 2; // low blue
              d[i + 3] = 255;
            }
            sctx.putImageData(noise, 0, 0);
          }
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
