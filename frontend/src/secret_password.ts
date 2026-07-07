import { float_alert } from "./float_alert";

// Password generator page. Talks to the backend template API by POSTing
// `{ "template": "..." }` (or `{ "type": "<preset label>" }`) to `/api/password`
// (nginx reroutes `/api` to the backend, which serves `/password`). The response
// is a JSON `{ template, password, entropy }` object, or a JSON
// `{ "error": "..." }` body on a non-2xx status. The preset list itself is served
// by the backend at `/api/password/types`.

type Preset = { label: string; template: string; hint: string };

const TOKENS: Array<[string, string]> = [
  ["{w} {W} {Y}", "word · Word · SCREAMING"],
  ["{l} {L}", "lower- / upper-case letter"],
  ["{n}", "digit 0–9"],
  ["{p}", "letter, digit or !?£&*"],
  ["{b}", "URL-safe base64 char"],
  ["{?}", "ASCII punctuation"],
  ["{e}", "emoji"],
  ["{s} {S}", "separator (random · repeated)"],
  ["{u}", "random v4 UUID"],
  ["{X5}", "five in a row, e.g. {n5}"],
  ["{X3-6}", "random count 3–6"],
  ["{X3-6-·}", "…joined by a separator"],
];

const DEFAULT_TEMPLATE = "{W}-{W}-{W}{n4}{?}";

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Password Generator
    </h1>
  </a>

  <div class="w-full max-w-xl mt-8 flex flex-col gap-4">
    <div class="flex flex-col sm:flex-row gap-2">
      <input id="pw-template" type="text" spellcheck="false" autocomplete="off"
        class="flex-1 bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-3 text-green-300 placeholder-green-900 font-mono"
        placeholder="{W}-{W}-{n4}" />
      <button id="pw-generate"
        class="bg-green-700 hover:bg-green-600 active:bg-green-800 text-white font-bold px-6 py-3 rounded cursor-pointer transition-colors">
        Generate
      </button>
    </div>

    <div id="pw-presets" class="flex flex-wrap gap-2"></div>

    <button id="pw-output" title="Click to copy"
      class="w-full min-h-18 bg-stone-900 border border-green-900 rounded px-4 py-4 text-center text-xl md:text-2xl font-mono whitespace-nowrap overflow-x-auto cursor-pointer hover:border-green-600 transition-colors text-green-300 select-text">
      <span class="text-green-800 italic text-base">Press Generate…</span>
    </button>

    <div id="pw-entropy" class="text-right text-sm font-mono text-green-800 h-5"></div>

    <details class="text-green-700 text-sm">
      <summary class="cursor-pointer hover:text-green-500 select-none">Template tokens</summary>
      <div id="pw-tokens" class="mt-3 flex flex-col gap-y-1"></div>
    </details>
  </div>
</div>`;

  const input = app.querySelector<HTMLInputElement>("#pw-template")!;
  const generateBtn = app.querySelector<HTMLButtonElement>("#pw-generate")!;
  const output = app.querySelector<HTMLButtonElement>("#pw-output")!;
  const entropyEl = app.querySelector<HTMLDivElement>("#pw-entropy")!;
  const presets = app.querySelector<HTMLDivElement>("#pw-presets")!;
  const tokens = app.querySelector<HTMLDivElement>("#pw-tokens")!;

  for (const [token, meaning] of TOKENS) {
    const row = document.createElement("div");
    row.className = "flex items-baseline gap-3 cursor-pointer";
    row.title = "Click to copy";
    row.innerHTML = `<code class="text-green-400 whitespace-nowrap shrink-0 w-28">${token}</code><span class="text-green-800">${meaning}</span>`;
    row.onclick = () => navigator.clipboard.writeText(token).catch(() => {});
    tokens.appendChild(row);
  }

  let requestId = 0;

  const setOutput = (text: string, tone: "password" | "error" | "muted") => {
    output.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = text;
    span.className =
      tone === "error"
        ? "text-red-400 text-base"
        : tone === "muted"
          ? "text-green-800 italic text-base"
          : "";
    output.appendChild(span);
    if (tone !== "password") setEntropy(null);
  };

  // Rough strength banding by bits of entropy, for a bit of colour/context.
  // Both data points are shown: `bits` is this password's actual entropy (the
  // headline), `minBits` the floor the template guarantees. Strength is rated by
  // the floor, so a lucky long draw from a range template can't flatter its
  // colour. For a fixed template the two are equal.
  const setEntropy = (bits: number | null, minBits?: number) => {
    if (bits === null) {
      entropyEl.textContent = "";
      return;
    }
    const rounded = Math.round(bits);
    const floor = typeof minBits === "number" ? Math.round(minBits) : rounded;
    // Strength bands on clean 20-bit boundaries; first band whose `max` the
    // floor falls under wins, so the final entry acts as the catch-all.
    const bands: { max: number; label: string; tone: string }[] = [
      { max: 20, label: "weak", tone: "text-red-400" },
      { max: 40, label: "fair", tone: "text-orange-400" },
      { max: 60, label: "good", tone: "text-yellow-500" },
      { max: 80, label: "strong", tone: "text-green-500" },
      { max: 100, label: "very strong", tone: "text-green-400" },
      { max: Infinity, label: "excellent", tone: "text-green-200" },
    ];
    const { label, tone } = bands.find((b) => floor < b.max)!;
    entropyEl.className = `text-right text-sm font-mono h-5 ${tone}`;
    entropyEl.textContent = `≈ ${rounded} bits · template ≥ ${floor} · ${label}`;
  };

  // Generate from the template in the input, or — when a preset chip is clicked —
  // from a `{ type }` payload the backend resolves against its own preset list.
  const generate = async (payload?: { type: string }) => {
    const template = input.value.trim();
    if (!payload && !template) {
      setOutput("Enter a template above.", "muted");
      return;
    }

    const id = ++requestId;
    generateBtn.disabled = true;
    setOutput("Generating…", "muted");

    try {
      const res = await fetch("/api/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? { template }),
      });
      if (id !== requestId) return; // a newer request superseded this one

      const contentType = res.headers.get("content-type") ?? "";
      const isJson = contentType.startsWith("application/json");

      if (res.ok && isJson) {
        const body = await res.json();
        if (typeof body?.password === "string") {
          // Reflect the template the backend actually used (e.g. for a preset).
          if (typeof body.template === "string") input.value = body.template;
          setOutput(body.password, "password");
          setEntropy(
            typeof body.entropy === "number" ? body.entropy : null,
            typeof body.min_entropy === "number" ? body.min_entropy : undefined,
          );
        } else {
          // A 2xx JSON that isn't the expected shape — never guess a password.
          setOutput("Unexpected response from the API.", "error");
        }
      } else if (res.ok) {
        // A 2xx that isn't JSON — e.g. a dev SPA fallback serving index.html.
        setOutput("Unexpected response from the API.", "error");
      } else {
        let message = `Error ${res.status}`;
        try {
          const body = await res.json();
          if (body && typeof body.error === "string") message = body.error;
        } catch {
          /* non-JSON error body — keep the status message */
        }
        setOutput(message, "error");
      }
    } catch {
      if (id === requestId)
        setOutput("Network error — is the API up?", "error");
    } finally {
      if (id === requestId) generateBtn.disabled = false;
    }
  };

  const copy = async (ev: MouseEvent) => {
    const text = output.textContent?.trim();
    if (!text || output.querySelector("span.italic")) return; // nothing real to copy
    try {
      await navigator.clipboard.writeText(text);
      output.animate([{ borderColor: "#16a34a" }, { borderColor: "" }], {
        duration: 600,
        easing: "ease-out",
      });
      float_alert(ev.clientX, ev.clientY, "Copied to clipboard");
    } catch {
      /* clipboard blocked — user can still select the text manually */
    }
  };

  // Render the preset chips served by the backend. Clicking one sends its label
  // as `{ type }`, so the backend's list stays the single source of truth.
  const renderPresets = (list: Preset[]) => {
    presets.innerHTML = "";
    for (const preset of list) {
      const chip = document.createElement("button");
      chip.textContent = preset.label;
      chip.title = `${preset.hint} — ${preset.template}`;
      chip.className =
        "text-sm border border-green-900 text-green-400 hover:bg-green-900/40 hover:text-green-200 rounded-full px-3 py-1 cursor-pointer transition-colors";
      chip.onclick = () => generate({ type: preset.label });
      presets.appendChild(chip);
    }
  };

  // Renders the preset chips and returns the first preset, which seeds the page.
  const loadPresets = async (): Promise<Preset | null> => {
    try {
      const res = await fetch("/api/password/types");
      if (!res.ok) return null;
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        renderPresets(list as Preset[]);
        return list[0] as Preset;
      }
    } catch {
      /* presets are a nicety — the template input still works without them */
    }
    return null;
  };

  generateBtn.onclick = () => generate();
  output.onclick = copy;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") generate();
  });

  // Seed the page from the first preset the backend serves. If the user starts
  // typing before the list arrives, respect their template; if the list can't be
  // loaded at all, fall back to DEFAULT_TEMPLATE.
  const init = async () => {
    const first = await loadPresets();
    if (input.value.trim() !== "") {
      generate();
    } else if (first) {
      input.value = first.template;
      generate({ type: first.label });
    } else {
      input.value = DEFAULT_TEMPLATE;
      generate();
    }
  };

  init();
};
