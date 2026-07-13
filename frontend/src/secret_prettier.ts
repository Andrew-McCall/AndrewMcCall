// Client-side code prettifier, powered by the real Prettier (standalone
// build) plus the community XML plugin, all pulled from a CDN as ES modules.
// Nothing is bundled: prettier-core loads after the page's `load` event so
// it never blocks first paint, and each language plugin is fetched lazily
// on first use (and cached) rather than all up front.

type Lang = "json" | "xml" | "html" | "css" | "babel";

const PRETTIER_URL = "https://esm.sh/prettier@3/standalone";
const PLUGIN_URLS: Record<string, string> = {
  babel: "https://esm.sh/prettier@3/plugins/babel",
  estree: "https://esm.sh/prettier@3/plugins/estree",
  postcss: "https://esm.sh/prettier@3/plugins/postcss",
  html: "https://esm.sh/prettier@3/plugins/html",
  xml: "https://esm.sh/@prettier/plugin-xml@3",
};

const PARSER_PLUGINS: Record<Lang, (keyof typeof PLUGIN_URLS)[]> = {
  json: ["babel", "estree"],
  xml: ["xml"],
  css: ["postcss"],
  html: ["html"],
  babel: ["babel", "estree"],
};

let prettierPromise: Promise<any> | null = null;
const pluginPromises = new Map<string, Promise<any>>();

const loadPrettier = (): Promise<any> => {
  if (!prettierPromise) {
    prettierPromise = import(/* @vite-ignore */ PRETTIER_URL);
  }
  return prettierPromise;
};

const loadPlugin = (name: keyof typeof PLUGIN_URLS): Promise<any> => {
  let promise = pluginPromises.get(name);
  if (!promise) {
    promise = import(/* @vite-ignore */ PLUGIN_URLS[name]);
    pluginPromises.set(name, promise);
  }
  return promise;
};

// Kick off the (small) prettier-core fetch once the page has finished
// loading, so the first format click doesn't pay that cost on top of the
// language-specific plugin(s).
const warmUp = () => {
  if (document.readyState === "complete") {
    window.setTimeout(loadPrettier, 0);
  } else {
    window.addEventListener("load", () => loadPrettier(), { once: true });
  }
};

const detectLang = (input: string): Lang => {
  const trimmed = input.trim();

  if (trimmed.startsWith("<")) {
    return /^<(!doctype html|html)\b/i.test(trimmed) ? "html" : "xml";
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";

  return "babel";
};

const PARSER_NAME: Record<Lang, string> = {
  json: "json",
  xml: "xml",
  css: "css",
  html: "html",
  babel: "babel",
};

const format = async (input: string, lang: Lang): Promise<string> => {
  const [prettier, ...plugins] = await Promise.all([
    loadPrettier(),
    ...PARSER_PLUGINS[lang].map((name) => loadPlugin(name)),
  ]);

  return prettier.format(input, {
    parser: PARSER_NAME[lang],
    plugins: plugins.map((mod) => mod.default ?? mod),
  });
};

export default (app: HTMLElement) => {
  warmUp();

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Prettier
    </h1>
  </a>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-4">
    <div class="flex flex-wrap gap-2 items-center">
      <select id="pretty-lang"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono">
        <option value="auto">Auto-detect</option>
        <option value="json">JSON</option>
        <option value="xml">XML</option>
        <option value="html">HTML</option>
        <option value="css">CSS</option>
        <option value="babel">JS</option>
      </select>
      <button id="pretty-format"
        class="border border-green-900 hover:border-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-green-300 font-bold px-6 py-2 rounded cursor-pointer transition-colors">
        Format
      </button>
      <button id="pretty-copy"
        class="border border-green-900 hover:border-green-600 text-green-300 font-bold px-6 py-2 rounded cursor-pointer transition-colors">
        Copy
      </button>
      <button id="pretty-clear"
        class="border border-green-900 hover:border-green-600 text-green-300 font-bold px-6 py-2 rounded cursor-pointer transition-colors">
        Clear
      </button>
      <span id="pretty-status" class="text-sm font-mono text-green-800"></span>
    </div>

    <div class="flex w-full h-56 bg-stone-900 border border-green-900 focus-within:border-green-600 rounded overflow-hidden">
      <div id="pretty-gutter"
        class="select-none text-right text-green-800 font-mono text-sm leading-normal py-3 pl-3 pr-2 overflow-hidden whitespace-pre">1</div>
      <textarea id="pretty-input" spellcheck="false" placeholder="Paste JSON, XML, HTML, CSS or JS… (Ctrl/Cmd+Enter to format)"
        class="flex-1 min-w-0 bg-transparent outline-none py-3 pr-3 text-green-300 placeholder-green-900 font-mono text-sm resize-none overflow-auto leading-normal"></textarea>
    </div>

    <pre id="pretty-output"
      class="w-full min-h-56 bg-stone-900 border border-green-900 rounded px-3 py-3 text-green-300 font-mono text-sm whitespace-pre-wrap break-words overflow-x-auto"></pre>

    <details id="pretty-stats" class="text-green-700 text-sm">
      <summary class="cursor-pointer hover:text-green-500 select-none">Stats</summary>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-y-1 gap-x-4 font-mono">
        <div>Characters: <span id="stat-chars" class="text-green-300">0</span></div>
        <div>Chars (no ws): <span id="stat-chars-nows" class="text-green-300">0</span></div>
        <div>Words: <span id="stat-words" class="text-green-300">0</span></div>
        <div>Lines: <span id="stat-lines" class="text-green-300">0</span></div>
        <div>Bytes: <span id="stat-bytes" class="text-green-300">0</span></div>
        <div>Longest line: <span id="stat-longest" class="text-green-300">0</span></div>
      </div>
    </details>
  </div>
</div>
`;

  const langSelect = app.querySelector("#pretty-lang") as HTMLSelectElement;
  const input = app.querySelector("#pretty-input") as HTMLTextAreaElement;
  const gutter = app.querySelector("#pretty-gutter") as HTMLElement;
  const output = app.querySelector("#pretty-output") as HTMLElement;
  const statusEl = app.querySelector("#pretty-status") as HTMLElement;
  const formatBtn = app.querySelector("#pretty-format") as HTMLButtonElement;
  const copyBtn = app.querySelector("#pretty-copy") as HTMLButtonElement;
  const clearBtn = app.querySelector("#pretty-clear") as HTMLButtonElement;

  const statChars = app.querySelector("#stat-chars") as HTMLElement;
  const statCharsNoWs = app.querySelector("#stat-chars-nows") as HTMLElement;
  const statWords = app.querySelector("#stat-words") as HTMLElement;
  const statLines = app.querySelector("#stat-lines") as HTMLElement;
  const statBytes = app.querySelector("#stat-bytes") as HTMLElement;
  const statLongest = app.querySelector("#stat-longest") as HTMLElement;

  const updateStats = () => {
    const text = output.textContent?.trim() ? output.textContent : input.value;
    const lines = text.split("\n");
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;

    statChars.textContent = text.length.toString();
    statCharsNoWs.textContent = text.replace(/\s/g, "").length.toString();
    statWords.textContent = words.toString();
    statLines.textContent = (text ? lines.length : 0).toString();
    statBytes.textContent = new TextEncoder().encode(text).length.toString();
    statLongest.textContent = Math.max(0, ...lines.map((l) => l.length)).toString();
  };

  const updateGutter = () => {
    const lineCount = input.value.split("\n").length;
    gutter.textContent = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
    gutter.scrollTop = input.scrollTop;
  };

  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle("text-red-500", isError);
    statusEl.classList.toggle("text-green-800", !isError);
  };

  const run = async () => {
    if (!input.value.trim()) return;

    const lang =
      langSelect.value === "auto"
        ? detectLang(input.value)
        : (langSelect.value as Lang);

    formatBtn.disabled = true;
    setStatus(`Formatting as ${lang}…`);

    try {
      output.textContent = await format(input.value, lang);
      setStatus("");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      formatBtn.disabled = false;
      updateStats();
    }
  };

  formatBtn.addEventListener("click", run);

  input.addEventListener("input", () => {
    updateStats();
    updateGutter();
  });

  input.addEventListener("scroll", () => {
    gutter.scrollTop = input.scrollTop;
  });

  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });

  copyBtn.addEventListener("click", async () => {
    if (!output.textContent) return;
    await navigator.clipboard.writeText(output.textContent);
    setStatus("Copied!");
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    output.textContent = "";
    setStatus("");
    updateStats();
    updateGutter();
    input.focus();
  });

  updateStats();
  updateGutter();
};
