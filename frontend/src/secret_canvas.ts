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
  static_fill: () => void;
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

// The "static" button is a reset whose seed is noise: it re-covers the board
// fully opaque, fills the grid with random static, and runs Life on from there
// at half the erosion rate (see static_fill in wasm).

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

  // Controls revealed *beneath* the board (lower z-index), clicked through the
  // eroded ground by the same forwarding as any other link. Reset re-covers the
  // page with the name; static re-covers it with random noise at half erosion.
  // Absolutely positioned (not fixed), so they scroll with the page.
  const controls = document.createElement("div");
  controls.style.cssText =
    "position:absolute;left:50%;top:20px;transform:translateX(-50%);z-index:40;" +
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
  staticBtn.addEventListener("click", () => game?.static_fill?.());

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
  // Set while dragging the beneath-canvas scrollbar through eroded ground.
  let scrollDrag: { id: number; startY: number; startScroll: number } | null =
    null;

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
    overlay.style.cursor =
      beneath && scrollbar.contains(beneath)
        ? "grab"
        : beneath?.closest("a, button, [data-url]")
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
    // A left press on see-through ground over the beneath-canvas scrollbar
    // grabs it to scroll, rather than eroding.
    if (ev.button === 0 && alphaAt(ev) < CLICK_THROUGH_ALPHA) {
      const el = elementBeneath(ev);
      if (el && scrollbar.contains(el)) {
        scrollDrag = {
          id: ev.pointerId,
          startY: ev.clientY,
          startScroll: document.documentElement.scrollTop,
        };
        dragged = true; // suppress the trailing click (secret counter / forward)
        overlay.setPointerCapture(ev.pointerId);
        return;
      }
    }
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
    if (scrollDrag && ev.pointerId === scrollDrag.id) {
      const track = scrollbar.clientHeight;
      const maxThumb = track - thumb.offsetHeight;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const scrolled =
        maxThumb > 0 ? ((ev.clientY - scrollDrag.startY) / maxThumb) * maxScroll : 0;
      window.scrollTo(0, scrollDrag.startScroll + scrolled);
      return;
    }
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
    if (scrollDrag && ev.pointerId === scrollDrag.id) {
      scrollDrag = null;
      return;
    }
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
      // Over see-through ground, scroll the page beneath; over the solid board,
      // fade it. The overlay swallows the native wheel-scroll, so drive it here.
      if (alphaAt(ev) < CLICK_THROUGH_ALPHA) {
        window.scrollBy(0, px);
        return;
      }
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

  // The OS scrollbar paints on top of the canvas at the very edge, where the
  // board's outer band always heals shut — so hide it and draw our own. This
  // one is a green-bordered rectangle, square corners, sitting *beneath* the
  // overlay (like the reset/static buttons): the opaque board covers it and it
  // shows through only where the ground erodes. It hides when nothing overflows.
  const scrollbarHide = document.createElement("style");
  scrollbarHide.textContent =
    "html{scrollbar-width:none}html::-webkit-scrollbar{display:none}";
  document.head.appendChild(scrollbarHide);

  // 6vmin inset ≈ just inside the board's self-healing outer band (~5% of the
  // shorter side), so the whole bar sits on ground that actually erodes.
  const scrollbar = document.createElement("div");
  scrollbar.style.cssText =
    "position:fixed;right:6vmin;top:6vmin;bottom:6vmin;width:12px;z-index:40;" +
    "border:1px solid #22c55e;background:rgba(12,10,9,.35);display:none";
  const thumb = document.createElement("div");
  thumb.style.cssText =
    "position:absolute;left:0;right:0;top:0;background:#16a34a;" +
    "border:1px solid #22c55e;box-sizing:border-box";
  scrollbar.appendChild(thumb);
  document.body.appendChild(scrollbar);

  const MIN_THUMB = 24;
  const updateScrollbar = () => {
    const doc = document.documentElement;
    const viewH = window.innerHeight;
    const scrollH = doc.scrollHeight;
    if (scrollH <= viewH + 1) {
      scrollbar.style.display = "none";
      return;
    }
    scrollbar.style.display = "block";
    const track = scrollbar.clientHeight;
    const thumbH = Math.max((viewH / scrollH) * track, MIN_THUMB);
    const maxScroll = scrollH - viewH;
    const maxThumb = track - thumbH;
    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${maxScroll > 0 ? (doc.scrollTop / maxScroll) * maxThumb : 0}px`;
  };

  const onScroll = () => updateScrollbar();
  window.addEventListener("scroll", onScroll, { passive: true });
  const scrollbarRO = new ResizeObserver(updateScrollbar);
  scrollbarRO.observe(document.body);

  document.body.appendChild(overlay);

  const ctx = canvas.getContext("2d");
  const bctx = blur.getContext("2d");
  if (!ctx || !bctx) {
    overlay.remove();
    controls.remove();
    return;
  }
  bctx.imageSmoothingEnabled = true; // average each 3x3 block on downsample

  let running = true;
  let raf = 0;
  let w = 0;
  let h = 0;

  const resize = () => {
    w = Math.min(canvas.clientWidth, MAX_W);
    h = Math.min(canvas.clientHeight, MAX_H);
    canvas.width = w;
    canvas.height = h;
    blur.width = Math.max(Math.ceil(w / BLUR_SCALE), 1);
    blur.height = Math.max(Math.ceil(h / BLUR_SCALE), 1);
    bctx.imageSmoothingEnabled = true; // reset: resizing clears the context
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
    window.removeEventListener("scroll", onScroll);
    scrollbarRO.disconnect();
    scrollbarHide.remove();
    scrollbar.remove();
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
