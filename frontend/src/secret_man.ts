// A unix command "man page" browser. Nothing is bundled: the pages themselves
// are the external dependency, pulled at runtime from the community
// tldr-pages corpus over a CDN (jsDelivr serves the GitHub repo with open
// CORS) — same "load it from a CDN instead of bundling" idea as the Prettier
// page, except here the CDN payload is documentation rather than a library.
//
// tldr pages are terse, example-first man pages for unix commands, one
// Markdown file per command under `pages/<platform>/<command>.md`. We fetch a
// command on demand, trying each platform in turn, and render the small,
// fixed Markdown dialect ourselves (headings, a `>` description, and
// `- description:` / `` `code` `` example pairs).

const CDN_BASE = "https://cdn.jsdelivr.net/gh/tldr-pages/tldr@main/pages";

// jsDelivr's data API returns a flat listing of every file in the repo (~2.8MB).
// We fetch it once, lazily, to build a complete command index: it drives the
// autocomplete and lets a lookup go straight to a platform that has the page
// instead of probing each one for a 404.
const INDEX_URL =
  "https://data.jsdelivr.com/v1/packages/gh/tldr-pages/tldr@main?structure=flat";

// Platforms to search, in order, when the user picks "Auto". `common` holds
// the cross-platform pages and covers the vast majority of commands.
const PLATFORMS = ["common", "linux", "osx", "windows", "android", "freebsd", "sunos"];

// command name -> platforms it has a page on, built lazily from INDEX_URL.
let commandIndex: Map<string, string[]> | null = null;
let indexPromise: Promise<Map<string, string[]>> | null = null;

const loadIndex = (): Promise<Map<string, string[]>> => {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`index fetch failed (${res.status})`);
        return res.json();
      })
      .then((data: { files: { name: string }[] }) => {
        const map = new Map<string, string[]>();
        // English pages live under `/pages/<platform>/<command>.md` (other
        // languages are under `/pages.<lang>/`, which this pattern skips).
        const re = /^\/pages\/([a-z0-9]+)\/(.+)\.md$/;
        for (const { name } of data.files) {
          const m = re.exec(name);
          if (!m) continue;
          const [, platform, command] = m;
          const platforms = map.get(command);
          if (platforms) platforms.push(platform);
          else map.set(command, [platform]);
        }
        commandIndex = map;
        return map;
      });
  }
  return indexPromise;
};

// A handful of popular unix commands offered as one-click chips.
const POPULAR = [
  "ls", "cd", "grep", "find", "tar", "curl", "ssh", "git", "awk", "sed",
  "chmod", "chown", "ps", "kill", "df", "du", "cat", "less", "rsync", "cron",
];

// Cache fetched raw Markdown so re-looking-up a command is instant.
const cache = new Map<string, string>();

// Fetch a command's page for a specific platform. Resolves to the raw
// Markdown, or null on a 404 (command not documented for that platform).
const fetchPage = async (platform: string, command: string): Promise<string | null> => {
  const key = `${platform}/${command}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached === "" ? null : cached;

  const res = await fetch(`${CDN_BASE}/${platform}/${encodeURIComponent(command)}.md`);
  if (res.status === 404) {
    cache.set(key, ""); // remember the miss so we don't refetch it
    return null;
  }
  if (!res.ok) throw new Error(`CDN returned ${res.status}`);

  const text = await res.text();
  cache.set(key, text);
  return text;
};

// Resolve a command across platforms. When a platform is given, try it first
// then fall back to `common`; otherwise walk the whole platform list. Returns
// the raw Markdown and the platform it was found on.
const lookup = async (
  command: string,
  platform: string,
): Promise<{ markdown: string; platform: string } | null> => {
  // Prefer the platforms the index says actually have this page; fall back to
  // probing the full list when the index hasn't loaded or doesn't know it.
  const known = commandIndex?.get(command);
  const base = known && known.length ? known : PLATFORMS;

  // Honour the user's platform choice by trying it first (if it's a candidate),
  // then the rest, so "Auto" and an explicit pick both do the fewest fetches.
  const order =
    platform === "auto" || !base.includes(platform)
      ? base
      : [platform, ...base.filter((p) => p !== platform)];

  for (const p of order) {
    const markdown = await fetchPage(p, command);
    if (markdown !== null) return { markdown, platform: p };
  }
  return null;
};

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Format a run of prose (a description line or a `>` line). Runs after
// escaping, so it matches on the escaped text: inline `code`, autolinked
// <urls>, and tldr's `[x]` option mnemonics (the highlighted letter you'd
// actually type, e.g. `[c]reate`).
const formatProse = (raw: string) =>
  escapeHtml(raw)
    .replace(
      /`([^`]+)`/g,
      '<code class="text-lime-300 bg-black/40 rounded px-1">$1</code>',
    )
    .replace(
      /&lt;(https?:\/\/[^&\s]+)&gt;/g,
      '<a href="$1" target="_blank" rel="noopener" class="text-lime-400 hover:underline break-all">$1</a>',
    )
    .replace(/\[([^\]]+)\]/g, '<span class="text-green-300 font-bold">$1</span>');

// Format an example's command line. `{{placeholders}}` are the bits the user
// swaps out, so we set them apart from the literal command text.
const formatCommand = (raw: string) =>
  escapeHtml(raw).replace(
    /\{\{(.+?)\}\}/g,
    '<span class="text-amber-400">$1</span>',
  );

// Render the tldr Markdown for one command into our terminal-green layout.
const renderMarkdown = (markdown: string): string => {
  const lines = markdown.split("\n");
  let title = "";
  const description: string[] = [];
  const examples: { text: string; command: string }[] = [];
  let pendingDesc: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("# ")) {
      title = trimmed.slice(2).trim();
    } else if (trimmed.startsWith("> ")) {
      description.push(trimmed.slice(2).trim());
    } else if (trimmed.startsWith("- ")) {
      // Example description; the code line follows on a later line.
      pendingDesc = trimmed.slice(2).replace(/:$/, "").trim();
    } else if (trimmed.startsWith("`") && pendingDesc !== null) {
      examples.push({
        text: pendingDesc,
        command: trimmed.replace(/^`/, "").replace(/`$/, ""),
      });
      pendingDesc = null;
    }
  }

  const examplesHtml = examples
    .map(
      (ex) => `
    <div class="border border-green-900/60 rounded overflow-hidden">
      <div class="px-3 py-2 text-green-400 text-sm">${formatProse(ex.text)}</div>
      <pre class="bg-black/40 px-3 py-2 text-sm overflow-x-auto text-green-200 font-mono border-t border-green-900/60"><code>${formatCommand(ex.command)}</code></pre>
    </div>`,
    )
    .join("");

  return `
    <h2 class="text-3xl font-bold text-green-400 font-mono">${escapeHtml(title)}</h2>
    <div class="mt-2 flex flex-col gap-1 text-green-600">
      ${description.map((d) => `<p>${formatProse(d)}</p>`).join("")}
    </div>
    <div class="mt-6 flex flex-col gap-3">${examplesHtml}</div>`;
};

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Man Pages
    </h1>
  </a>

  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Example-first man pages for unix commands, pulled live from the community
    <span class="text-green-500">tldr-pages</span> corpus over a CDN. Type a
    command and hit <span class="text-green-500">Look up</span>.
  </p>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-4">
    <div class="flex flex-wrap gap-2 items-center">
      <input id="man-input" type="text" spellcheck="false" autocapitalize="off"
        list="man-commands" autocomplete="off"
        placeholder="Command name, e.g. tar  (Enter to look up)"
        class="flex-1 min-w-[12rem] bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono" />
      <datalist id="man-commands"></datalist>
      <select id="man-platform"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono">
        <option value="auto">Auto</option>
        <option value="common">common</option>
        <option value="linux">linux</option>
        <option value="osx">osx</option>
        <option value="windows">windows</option>
        <option value="android">android</option>
        <option value="freebsd">freebsd</option>
        <option value="sunos">sunos</option>
      </select>
      <button id="man-lookup"
        class="border border-green-900 hover:border-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-green-300 font-bold px-6 py-2 rounded cursor-pointer transition-colors">
        Look up
      </button>
      <span id="man-status" class="text-sm font-mono text-green-800"></span>
    </div>

    <div class="flex flex-wrap gap-2">
      ${POPULAR.map(
        (cmd) =>
          `<button data-cmd="${cmd}" class="man-chip border border-green-900 hover:border-green-600 text-green-400 font-mono text-sm px-3 py-1 rounded cursor-pointer transition-colors">${cmd}</button>`,
      ).join("")}
    </div>

    <div id="man-output"
      class="w-full min-h-56 bg-stone-900 border border-green-900 rounded px-4 py-4 font-mono"></div>
  </div>
</div>
`;

  const input = app.querySelector("#man-input") as HTMLInputElement;
  const datalist = app.querySelector("#man-commands") as HTMLDataListElement;
  const platformSelect = app.querySelector("#man-platform") as HTMLSelectElement;
  const lookupBtn = app.querySelector("#man-lookup") as HTMLButtonElement;
  const statusEl = app.querySelector("#man-status") as HTMLElement;
  const output = app.querySelector("#man-output") as HTMLElement;

  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle("text-red-500", isError);
    statusEl.classList.toggle("text-green-800", !isError);
  };

  // Guards against a slow fetch landing after a newer lookup has started.
  let requestId = 0;

  const run = async () => {
    const command = input.value.trim().toLowerCase();
    if (!command) return;

    const id = ++requestId;
    lookupBtn.disabled = true;
    setStatus(`Looking up ${command}…`);

    try {
      const result = await lookup(command, platformSelect.value);
      if (id !== requestId) return; // a newer lookup superseded this one

      if (!result) {
        output.innerHTML = `<p class="text-green-800">No page found for <span class="text-green-400">${escapeHtml(command)}</span>. Try another command or platform.</p>`;
        setStatus("Not found", true);
        return;
      }

      output.innerHTML = renderMarkdown(result.markdown);
      setStatus(result.platform);
    } catch (err) {
      if (id !== requestId) return;
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      if (id === requestId) lookupBtn.disabled = false;
    }
  };

  lookupBtn.addEventListener("click", run);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });

  app.querySelectorAll<HTMLButtonElement>(".man-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      input.value = chip.dataset.cmd!;
      run();
    });
  });

  input.focus();

  // Pull the command index once the page has settled (it's a big file), then
  // fill the autocomplete with every known command. A failure here is silent —
  // lookups still work by probing platforms directly.
  const populateAutocomplete = () => {
    loadIndex()
      .then((map) => {
        datalist.innerHTML = [...map.keys()]
          .sort()
          .map((cmd) => `<option value="${escapeHtml(cmd)}"></option>`)
          .join("");
      })
      .catch(() => {});
  };
  if (document.readyState === "complete") window.setTimeout(populateAutocomplete, 0);
  else window.addEventListener("load", populateAutocomplete, { once: true });
};
