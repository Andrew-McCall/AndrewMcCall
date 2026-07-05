import { float_alert } from "./float_alert";

// Password generator page. Talks to the backend template API at
// `/api/password/{template}` (nginx reroutes `/api` to the backend, which
// serves `/password/{template}`). The response is the generated password as
// plain text, or a JSON `{ "error": "..." }` body on a non-2xx status.

type Preset = { label: string; template: string; hint: string };

const PRESETS: Preset[] = [
  { label: "Memorable", template: "{W}-{W}-{W}{n4}{?}", hint: "Three words + digits" },
  { label: "Passphrase", template: "{w} {w} {w} {W}", hint: "Four words, spaced" },
  { label: "Strong", template: "{p24}", hint: "20 mixed characters" },
  { label: "PIN", template: "{n6}", hint: "Six digits" },
  { label: "Base64 key", template: "{b32}", hint: "32 URL-safe chars" },
  { label: "UUID", template: "{u}", hint: "Random v4 UUID" },
];

const TOKENS: Array<[string, string]> = [
  ["{w} {W} {S}", "word · Word · SCREAMING"],
  ["{l} {L}", "lower- / upper-case letter"],
  ["{n}", "digit 0–9"],
  ["{p}", "letter, digit or !?£&*"],
  ["{b}", "URL-safe base64 char"],
  ["{?}", "ASCII punctuation"],
  ["{e}", "emoji"],
  ["{u}", "random v4 UUID"],
  ["{X5}", "five in a row, e.g. {n5}"],
  ["{X3-6}", "random count 3–6"],
  ["{X3-6-·}", "…joined by a separator"],
];

const DEFAULT_TEMPLATE = PRESETS[0].template;

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-gradient-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
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
      class="w-full min-h-[4.5rem] bg-stone-900 border border-green-900 rounded px-4 py-4 text-center text-xl md:text-2xl font-mono break-all cursor-pointer hover:border-green-600 transition-colors text-green-300 select-text">
      <span class="text-green-800 italic text-base">Press Generate…</span>
    </button>

    <details class="text-green-700 text-sm">
      <summary class="cursor-pointer hover:text-green-500 select-none">Template tokens</summary>
      <div id="pw-tokens" class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1"></div>
    </details>
  </div>
</div>`;

  const input = app.querySelector<HTMLInputElement>("#pw-template")!;
  const generateBtn = app.querySelector<HTMLButtonElement>("#pw-generate")!;
  const output = app.querySelector<HTMLButtonElement>("#pw-output")!;
  const presets = app.querySelector<HTMLDivElement>("#pw-presets")!;
  const tokens = app.querySelector<HTMLDivElement>("#pw-tokens")!;

  input.value = DEFAULT_TEMPLATE;

  for (const preset of PRESETS) {
    const chip = document.createElement("button");
    chip.textContent = preset.label;
    chip.title = `${preset.hint} — ${preset.template}`;
    chip.className =
      "text-sm border border-green-900 text-green-400 hover:bg-green-900/40 hover:text-green-200 rounded-full px-3 py-1 cursor-pointer transition-colors";
    chip.onclick = () => {
      input.value = preset.template;
      generate();
    };
    presets.appendChild(chip);
  }

  for (const [token, meaning] of TOKENS) {
    const row = document.createElement("div");
    row.className = "flex gap-2 cursor-pointer";
    row.title = "Click to copy";
    row.innerHTML = `<code class="text-green-400 whitespace-nowrap">${token}</code><span class="text-green-800">${meaning}</span>`;
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
  };

  const generate = async () => {
    const template = input.value.trim();
    if (!template) {
      setOutput("Enter a template above.", "muted");
      return;
    }

    const id = ++requestId;
    generateBtn.disabled = true;
    setOutput("Generating…", "muted");

    try {
      const res = await fetch(`/api/password/${encodeURIComponent(template)}`);
      if (id !== requestId) return; // a newer request superseded this one

      const contentType = res.headers.get("content-type") ?? "";

      if (res.ok && contentType.startsWith("text/plain")) {
        setOutput(await res.text(), "password");
      } else if (res.ok) {
        // A 2xx that isn't the plaintext password — e.g. a dev SPA fallback
        // serving index.html. Never surface that as a password.
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
      if (id === requestId) setOutput("Network error — is the API up?", "error");
    } finally {
      if (id === requestId) generateBtn.disabled = false;
    }
  };

  const copy = async (ev: MouseEvent) => {
    const text = output.textContent?.trim();
    if (!text || output.querySelector("span.italic")) return; // nothing real to copy
    try {
      await navigator.clipboard.writeText(text);
      output.animate(
        [{ borderColor: "#16a34a" }, { borderColor: "" }],
        { duration: 600, easing: "ease-out" },
      );
      float_alert(ev.clientX, ev.clientY, "Copied to clipboard");
    } catch {
      /* clipboard blocked — user can still select the text manually */
    }
  };

  generateBtn.onclick = generate;
  output.onclick = copy;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") generate();
  });

  generate();
};
