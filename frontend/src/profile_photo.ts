// Interactive profile photo: a circular, 1px green-stroked canvas that stays
// hidden until the pointer rests over it. Hover is forwarded from the eroding
// canvas overlay as a `profilehover` event carrying the pointer position (the
// overlay eats native :hover); native listeners cover the case where it isn't
// up. The image reads pure green at the rim and fades to its true colour toward
// the centre, and pixelation tracks the green so the greenest edge is blockiest.

type Hover = { x: number; y: number } | null;

export const initProfilePhoto = (canvas: HTMLCanvasElement, src: string) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const CSS = 112; // matches the old w-28 h-28 footprint
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const N = Math.round(CSS * dpr);
  const r = N / 2;
  const r2 = r * r;
  const MAX_BLOCK = Math.max(2, Math.round(12 * dpr));

  canvas.width = N;
  canvas.height = N;
  canvas.style.width = canvas.style.height = `${CSS}px`;
  canvas.style.opacity = "0";
  canvas.style.transition = "opacity 0.25s";

  let base: ImageData | null = null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
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
  };
  img.src = src;

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
        d[di] = sr * (1 - g) + lum * 0.2 * g;
        d[di + 1] = sg * (1 - g) + lum * g;
        d[di + 2] = sb * (1 - g) + lum * 0.2 * g;
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

  const onHover = (h: Hover) => {
    if (!h) {
      canvas.style.opacity = "0";
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(h.x - cx, h.y - cy);
    canvas.style.opacity = "1";
    render(Math.min(1, dist / (rect.width / 2)));
  };

  canvas.addEventListener("profilehover", (e) =>
    onHover((e as CustomEvent<Hover>).detail),
  );
  // Fallback for when the canvas overlay isn't covering the page.
  const fromEvent = (e: PointerEvent) =>
    onHover({ x: e.clientX, y: e.clientY });
  canvas.addEventListener("pointerenter", fromEvent);
  canvas.addEventListener("pointermove", fromEvent);
  canvas.addEventListener("pointerleave", () => onHover(null));
};
