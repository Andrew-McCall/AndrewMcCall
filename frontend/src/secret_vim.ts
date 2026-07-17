// A real Vim editor with no bundled dependency: CodeMirror 5 and its
// first-party Vim keymap are pulled from a CDN at page load — the same
// "serve it from a CDN, add nothing to package.json" trick secret_prettier.ts
// uses for Prettier. CM5 ships as a classic UMD bundle that augments a single
// `window.CodeMirror`, so the vim/dialog/search add-ons attach to the exact
// same instance (the CM6 ESM path silently fails to bind keys because esm.sh
// hands each module its own @codemirror/state copy).

const VER = "5.65.16";
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/codemirror/${VER}`;

const CSS = [`${CDN}/codemirror.min.css`, `${CDN}/addon/dialog/dialog.min.css`];
// Core must load before the add-ons, which all augment window.CodeMirror.
const CORE = `${CDN}/codemirror.min.js`;
const ADDONS = [
  `${CDN}/keymap/vim.min.js`,
  `${CDN}/addon/dialog/dialog.min.js`, // vim's ":" / "/" command line
  `${CDN}/addon/search/searchcursor.min.js`, // vim search (/, n, N, :s)
];

declare global {
  interface Window {
    CodeMirror: any;
  }
}

const loadCss = (href: string) =>
  new Promise<void>((resolve) => {
    if (document.querySelector(`link[href="${href}"]`)) return resolve();
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    l.onload = () => resolve();
    l.onerror = () => resolve(); // a missing stylesheet shouldn't block the editor
    document.head.appendChild(l);
  });

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });

let editorPromise: Promise<any> | null = null; // resolves to the CodeMirror instance

const buildEditor = async (doc: string): Promise<any> => {
  CSS.forEach(loadCss);
  await loadScript(CORE);
  await Promise.all(ADDONS.map(loadScript));

  const CodeMirror = window.CodeMirror;

  // :w is a no-op here; :q (and :wq) drop you back on the secret menu.
  CodeMirror.Vim.defineEx("write", "w", () => {});
  CodeMirror.Vim.defineEx("quit", "q", () => window.navigate("/secret"));

  const host = document.createElement("div");
  host.className = "vim-cm w-full";

  const cm = CodeMirror(host, {
    value: doc,
    keyMap: "vim",
    lineNumbers: true,
    showCursorWhenSelecting: true,
    lineWrapping: true,
  });
  cm.setSize("100%", "24rem");

  // Stash the wrapper so the page-render code can (re-)mount it.
  cm.__host = host;
  return cm;
};

const SAMPLE = `Welcome to Vim — the real thing, running in your browser.

This editor is CodeMirror with its first-party Vim keymap, both loaded
straight from a CDN at page load. Nothing is bundled into the site.

Try the classics:
  dd      delete a line            yy / p   yank & paste
  cw      change a word            x        delete a char
  A       append at line end       o        open a line below
  /word   search, then n / N       u        undo, Ctrl-r redo
  gg / G  top / bottom             v / V    visual / visual-line
  :w      "write" (no-op here)     :q       quit back to the menu

Press i to insert, Esc to return to normal mode. Have fun.
`;

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Vim
    </h1>
  </a>

  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Real CodeMirror + Vim, fetched from a CDN on load — no bundled deps.
    Press <span class="text-green-500">i</span> to insert,
    <span class="text-green-500">Esc</span> for normal, <span class="text-green-500">:q</span> to leave.
  </p>

  <div id="vim-host"
    class="w-full max-w-3xl mt-6 bg-stone-900 border border-green-900 focus-within:border-green-600 overflow-hidden">
    <div id="vim-loading" class="px-4 py-16 text-center text-green-800 font-mono text-sm">
      Loading editor…
    </div>
  </div>
</div>
`;

  const host = app.querySelector("#vim-host") as HTMLElement;

  // Build the editor once and reuse it across navigations (preserves the
  // buffer). The CDN fetch starts here, on first visit to /secret/vim.
  if (!editorPromise) editorPromise = buildEditor(SAMPLE);

  editorPromise
    .then((cm) => {
      // Guard against the user navigating away before the CDN load resolved.
      if (!document.body.contains(host)) return;
      host.innerHTML = "";
      host.appendChild(cm.__host);
      cm.refresh(); // CM needs a re-measure after being re-parented
      cm.focus();
    })
    .catch((err) => {
      // Without this, a single transient CDN hiccup poisons the cached promise
      // forever — every future visit would replay the same failure with no way
      // to retry short of a full page reload.
      editorPromise = null;
      if (!document.body.contains(host)) return;
      host.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "px-4 py-16 text-center text-red-400 font-mono text-sm";
      msg.textContent =
        "Failed to load the editor from the CDN: " +
        (err instanceof Error ? err.message : String(err)) +
        " — leave and come back to retry.";
      host.appendChild(msg);
    });
};
