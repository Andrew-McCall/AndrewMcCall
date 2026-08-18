// Interactive profile photo: a circular, 1px green-stroked canvas that stays
// hidden until the pointer rests over it. Hover is forwarded from the eroding
// canvas overlay as a `profilehover` event carrying the pointer position (the
// overlay eats native :hover); native listeners cover the case where it isn't
// up. The image reads pure green at the rim and fades to its true colour toward
// the centre, and pixelation tracks the green so the greenest edge is blockiest.

import { isMobile } from "./mobile.ts";

type Hover = { x: number; y: number } | null;

export const initProfilePhoto = (canvas: HTMLCanvasElement, src: string) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Mobile has no hover, so instead of hiding until pointed at, the photo rests
  // visible and greenest, and a finger-drag across it sharpens toward the touch.
  const mobile = isMobile();
  if (mobile) canvas.style.touchAction = "none"; // drags drive the effect, not scroll

  // The frame's CSS size comes from its container (w-full/aspect-square on
  // mobile, w-44/h-44 from sm: up — see home.ts) rather than a fixed guess, so
  // the drawn circle always fills whatever box the layout actually gives it.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let N = 0;
  let r = 0;
  let r2 = 0;
  let MAX_BLOCK = 2;

  canvas.style.opacity = "0";
  canvas.style.transition = "opacity 0.25s";

  let base: ImageData | null = null;
  const img = new Image();
  img.crossOrigin = "anonymous";

  // Re-measures the container and redraws at that size. Called once the image
  // is ready, and again whenever the box is resized (breakpoint change,
  // orientation change) so the canvas never gets stuck at a stale size.
  const draw = () => {
    const cssSize = Math.round(canvas.getBoundingClientRect().width);
    if (!cssSize || !img.complete || img.naturalWidth === 0) return;
    N = Math.round(cssSize * dpr);
    r = N / 2;
    r2 = r * r;
    MAX_BLOCK = Math.max(2, Math.round(12 * dpr));
    canvas.width = N;
    canvas.height = N;
    canvas.style.width = canvas.style.height = `${cssSize}px`;

    // Draw object-cover into the square, then cache it as the untinted source.
    const scale = Math.max(N / img.width, N / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.clearRect(0, 0, N, N);
    ctx.drawImage(img, (N - dw) / 2, (N - dh) / 2, dw, dh);
    try {
      base = ctx.getImageData(0, 0, N, N);
    } catch {
      base = null; // cross-origin taint: leave the plain image, effect off
    }
    rest(); // show the resting state on mobile once the source is cached
  };
  img.onload = draw;
  img.src = src;
  new ResizeObserver(draw).observe(canvas);

  // g in [0,1]: 0 at centre (true colour, sharp), 1 at rim (full green, blocky).
  const render = (g: number) => {
    if (!base) return;
    const s = base.data;
    const out = ctx.createImageData(N, N);
    const d = out.data;
    const block = Math.max(1, Math.round(1 + g * (MAX_BLOCK - 1)));
    for (let y = 0; y < N; y++) {
      const dy = y - r + 0.5;
      for (let x = 0; x < N; x++) {
        const di = (y * N + x) * 4;
        const dx = x - r + 0.5;
        if (dx * dx + dy * dy > r2) continue; // outside circle → transparent
        const sx = Math.min(
          N - 1,
          Math.floor(x / block) * block + (block >> 1),
        );
        const sy = Math.min(
          N - 1,
          Math.floor(y / block) * block + (block >> 1),
        );
        const si = (sy * N + sx) * 4;
        const sr = s[si];
        const sg = s[si + 1];
        const sb = s[si + 2];
        const lum = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        const dark = 0.3; // darken the green tint toward black at the rim
        d[di] = sr * (1 - g) + lum * 0.2 * dark * g;
        d[di + 1] = sg * (1 - g) + lum * dark * g;
        d[di + 2] = sb * (1 - g) + lum * 0.2 * dark * g;
        d[di + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    ctx.beginPath();
    ctx.arc(r, r, r - dpr / 2, 0, Math.PI * 2);
    ctx.lineWidth = dpr; // 1 CSS px
    ctx.strokeStyle = "#22c55e"; // green-500
    ctx.stroke();
  };

  // No pointer over the photo: hidden on desktop, but on mobile it stays visible
  // at its greenest/blockiest resting state, inviting a drag to sharpen it.
  const rest = () => {
    if (mobile) {
      canvas.style.opacity = "1";
      render(1);
    } else {
      canvas.style.opacity = "0";
    }
  };

  const onHover = (h: Hover) => {
    if (!h) {
      rest();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(h.x - cx, h.y - cy);
    canvas.style.opacity = "1";
    // The inner 5% of the radius is a "perfect zone": fully sharp, true colour.
    // Beyond it, green/pixelation ramps from 0 at the zone edge to 1 at the rim.
    const PERFECT = 0.05;
    const t = dist / (rect.width / 2); // 0 at centre, 1 at rim
    render(t <= PERFECT ? 0 : Math.min(1, (t - PERFECT) / (1 - PERFECT)));
  };

  canvas.addEventListener("profilehover", (e) =>
    onHover((e as CustomEvent<Hover>).detail),
  );
  // Fallback for when the canvas overlay isn't covering the page.
  const fromEvent = (e: PointerEvent) =>
    onHover({ x: e.clientX, y: e.clientY });
  canvas.addEventListener("pointerdown", fromEvent);
  canvas.addEventListener("pointerenter", fromEvent);
  canvas.addEventListener("pointermove", fromEvent);
  canvas.addEventListener("pointerleave", () => onHover(null));
  canvas.addEventListener("pointercancel", () => onHover(null));
};
