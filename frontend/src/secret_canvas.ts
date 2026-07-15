// Fullscreen WASM game overlay.
//
// The game runs on a fixed, viewport-filling <canvas> layered above the SPA,
// mounted on <body> (not inside #app). An SVG cover hides the canvas until the
// player dismisses it. Hiding the game tears everything down and reveals the
// normal SPA underneath — no re-render needed, since #app is never touched.
//
// The wasm module owns a fixed RGBA framebuffer in linear memory: we call
// `tick(w, h, dt)` each frame to advance + render, then blit with putImageData.

interface GameWasm {
  memory: WebAssembly.Memory;
  frame_ptr: () => number;
  tick: (width: number, height: number, dt: number) => void;
  reset: () => void;
}

// Must match MAX_W / MAX_H in wasm/src/lib.rs — the framebuffer's hard cap.
const MAX_W = 1920;
const MAX_H = 1080;

let teardown: (() => void) | null = null;

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
/// game isn't running. The router calls this on any navigation away.
export function hideGame(): void {
  teardown?.();
  teardown = null;
}

export default (app: HTMLElement) => {
  app.innerHTML = ""; // the game is a body-level overlay; #app stays empty
  if (teardown) return; // already running

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:50;background:#0c0a09;overflow:hidden";

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "width:100%;height:100%;display:block;image-rendering:pixelated";
  overlay.appendChild(canvas);

  // Populated once the wasm finishes loading; used to (re)start play on reveal.
  let game: GameWasm | null = null;

  // SVG cover — hides the running game until clicked. Dismissing it restarts
  // the simulation so play always begins centred, not mid-flight.
  const cover = document.createElement("img");
  cover.src = "/chip.svg";
  cover.draggable = false;
  cover.title = "click to play";
  cover.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;" +
    "padding:12vmin;box-sizing:border-box;cursor:pointer;background:#0c0a09";
  cover.addEventListener("click", () => {
    cover.remove();
    game?.reset();
  });
  overlay.appendChild(cover);

  // Escape exits, but that's invisible and unreachable on touch devices with
  // no keyboard — give everyone a visible, tappable way out too.
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕ exit";
  closeBtn.title = "Back to the secret menu (Esc)";
  closeBtn.style.cssText =
    "position:absolute;top:1rem;right:1rem;z-index:1;padding:0.4rem 0.8rem;" +
    "border:1px solid rgba(34,197,94,0.4);border-radius:0.375rem;background:rgba(12,10,9,0.7);" +
    "color:#4ade80;font:12px monospace;cursor:pointer";
  closeBtn.addEventListener("click", () => window.navigate("/secret"));
  overlay.appendChild(closeBtn);

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
      // Without this the cover's "click to play" just silently no-ops forever
      // (`game` never gets set) and the player has no idea anything went wrong.
      cover.title = "failed to load — use ✕ exit to go back";
      cover.style.cursor = "not-allowed";
    });
};
