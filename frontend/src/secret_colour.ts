// A colour picker + palette generator built on the real chroma-js, pulled
// from a CDN as an ES module (same approach as the Prettier page). Nothing is
// bundled: chroma is fetched after the page's `load` event so it never blocks
// first paint, and cached for the life of the page. chroma does the heavy
// lifting — parsing every notation you'd actually type (#rgb / #rrggbb /
// #rrggbbaa, rgb()/rgba(), hsl()/hsla(), and the CSS named colours), the
// format conversions, and the HSL-space maths the palettes are derived from.

const CHROMA_URL = "https://esm.sh/chroma-js@3";

let chromaPromise: Promise<any> | null = null;
const loadChroma = (): Promise<any> => {
  if (!chromaPromise) {
    chromaPromise = import(/* @vite-ignore */ CHROMA_URL).then(
      (mod) => mod.default ?? mod,
    );
  }
  return chromaPromise;
};

// Kick off the fetch once the page has finished loading, so the first
// interaction doesn't pay that cost.
const warmUp = () => {
  if (document.readyState === "complete") {
    window.setTimeout(loadChroma, 0);
  } else {
    window.addEventListener("load", () => loadChroma(), { once: true });
  }
};

type Scheme =
  | "complementary"
  | "analogous"
  | "triadic"
  | "tetradic"
  | "monochromatic"
  | "shades";

// Derive a palette from a base chroma colour using classic colour-theory
// relationships, all expressed as hue rotations / lightness steps in HSL.
const buildPalette = (chroma: any, base: any): Record<Scheme, () => any[]> => {
  const rot = (deg: number) =>
    base.set("hsl.h", `+${((deg % 360) + 360) % 360}`);
  const light = (l: number) => base.set("hsl.l", Math.max(0, Math.min(1, l)));
  return {
    complementary: () => [base, rot(180)],
    analogous: () => [rot(-60), rot(-30), base, rot(30), rot(60)],
    triadic: () => [base, rot(120), rot(240)],
    tetradic: () => [base, rot(90), rot(180), rot(270)],
    monochromatic: () => {
      const l = base.get("hsl.l");
      return [-0.3, -0.15, 0, 0.15, 0.3].map((d) => light(l + d));
    },
    shades: () =>
      chroma
        .scale([base.set("hsl.l", 0.9), base.set("hsl.l", 0.2)])
        .mode("hsl")
        .colors(5)
        .map((h: string) => chroma(h)),
  };
};

// Readable text colour (near-black / near-white) for a given background.
const contrastText = (chroma: any, c: any) =>
  chroma.contrast(c, "#f5f5f4") >= chroma.contrast(c, "#0c0a09")
    ? "#f5f5f4"
    : "#0c0a09";

export default (app: HTMLElement) => {
  warmUp();

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Colour Picker
    </h1>
  </a>

  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Type a colour any way you like — <span class="text-green-500">#3cb371</span>,
    <span class="text-green-500">rgb(60 179 113)</span>, <span class="text-green-500">hsl(146 50% 47%)</span>
    or just <span class="text-green-500">teal</span> — then generate a palette.
  </p>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-6">
    <div class="flex flex-wrap items-center gap-3">
      <input id="col-native" type="color" value="#3cb371"
        class="w-16 h-16 shrink-0 bg-transparent border border-green-900 cursor-pointer" />
      <input id="col-input" type="text" spellcheck="false" placeholder="#3cb371, rgb(…), hsl(…), teal…"
        class="flex-1 min-w-48 bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-3 text-green-300 placeholder-green-900 font-mono" />
      <span id="col-error" class="text-red-500 font-mono text-sm"></span>
    </div>

    <div class="flex flex-wrap items-stretch gap-3">
      <div id="col-preview" class="flex-1 min-w-40 min-h-28 border border-green-900 flex items-center justify-center font-mono text-sm"></div>
      <div class="flex flex-col gap-2 font-mono text-sm">
        <button data-fmt="hex" class="col-chip border border-green-900 hover:border-green-600 px-3 py-2 text-left text-green-300 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"></button>
        <button data-fmt="rgb" class="col-chip border border-green-900 hover:border-green-600 px-3 py-2 text-left text-green-300 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"></button>
        <button data-fmt="hsl" class="col-chip border border-green-900 hover:border-green-600 px-3 py-2 text-left text-green-300 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"></button>
      </div>
    </div>

    <div class="flex flex-wrap gap-2 items-center">
      <select id="col-scheme"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 font-mono">
        <option value="complementary">Complementary</option>
        <option value="analogous">Analogous</option>
        <option value="triadic">Triadic</option>
        <option value="tetradic">Tetradic</option>
        <option value="monochromatic">Monochromatic</option>
        <option value="shades">Tints &amp; Shades</option>
      </select>
      <button id="col-random" class="border border-green-900 hover:border-green-600 text-green-300 font-bold px-6 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">
        Random
      </button>
      <span id="col-status" class="text-sm font-mono text-green-800"></span>
    </div>

    <div id="col-palette" class="grid grid-cols-2 sm:grid-cols-5 gap-3"></div>
  </div>
</div>
`;

  const native = app.querySelector("#col-native") as HTMLInputElement;
  const textInput = app.querySelector("#col-input") as HTMLInputElement;
  const errorEl = app.querySelector("#col-error") as HTMLElement;
  const preview = app.querySelector("#col-preview") as HTMLElement;
  const scheme = app.querySelector("#col-scheme") as HTMLSelectElement;
  const randomBtn = app.querySelector("#col-random") as HTMLButtonElement;
  const statusEl = app.querySelector("#col-status") as HTMLElement;
  const paletteEl = app.querySelector("#col-palette") as HTMLElement;
  const chips = Array.from(
    app.querySelectorAll<HTMLButtonElement>(".col-chip"),
  );

  let chroma: any = null;
  let current: any = null; // a chroma colour, once the library has loaded

  const setStatus = (t: string) => {
    statusEl.textContent = t;
    if (t) window.setTimeout(() => (statusEl.textContent = ""), 1200);
  };

  const copy = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`Copied ${text}`);
    } catch {
      setStatus("Clipboard blocked");
    }
  };

  const formatFor = (fmt: string, c: any) =>
    fmt === "hex" ? c.hex() : fmt === "rgb" ? c.css() : c.css("hsl");

  const renderPalette = () => {
    if (!chroma || !current) return;
    const colours = buildPalette(chroma, current)[scheme.value as Scheme]();
    paletteEl.innerHTML = colours
      .map((c: any) => {
        const hex = c.hex();
        return `<button data-hex="${hex}" title="Click to copy"
          class="col-swatch h-24 border border-green-900/60 hover:border-green-500 flex items-end justify-center pb-2 font-mono text-xs cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
          style="background:${hex};color:${contrastText(chroma, c)}">${hex}</button>`;
      })
      .join("");
    paletteEl
      .querySelectorAll<HTMLButtonElement>(".col-swatch")
      .forEach((el) => {
        el.addEventListener("click", () => copy(el.dataset.hex!));
      });
  };

  const render = () => {
    if (!current) return;
    native.value = current.hex().slice(0, 7);
    preview.style.background = current.css();
    preview.style.color = contrastText(chroma, current);
    preview.textContent = current.hex();
    chips.forEach(
      (chip) => (chip.textContent = formatFor(chip.dataset.fmt!, current)),
    );
    renderPalette();
  };

  const setColour = (c: any, syncText = true) => {
    current = c;
    errorEl.textContent = "";
    if (syncText) textInput.value = c.hex();
    render();
  };

  textInput.addEventListener("input", () => {
    if (!chroma) return;
    const value = textInput.value.trim();
    if (!value) {
      errorEl.textContent = "";
      return;
    }
    if (chroma.valid(value)) {
      errorEl.textContent = "";
      setColour(chroma(value), false);
    } else {
      errorEl.textContent = "unrecognised colour";
    }
  });

  native.addEventListener("input", () => {
    if (chroma) setColour(chroma(native.value));
  });

  scheme.addEventListener("change", renderPalette);

  randomBtn.addEventListener("click", () => {
    if (chroma) setColour(chroma.random());
  });

  chips.forEach((chip) =>
    chip.addEventListener("click", () => copy(chip.textContent!)),
  );

  // chroma powers everything, so hold interaction until it has loaded.
  loadChroma()
    .then((lib) => {
      chroma = lib;
      setColour(chroma("#3cb371"));
    })
    .catch(() => {
      // Without resetting this, one failed fetch leaves `chroma` null and the
      // whole page permanently inert — reset it so leaving and coming back
      // retries instead of replaying the same cached failure forever.
      chromaPromise = null;
      errorEl.textContent =
        "failed to load colour library — leave and come back to retry";
    });
};
