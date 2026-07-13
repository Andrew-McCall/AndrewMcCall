// A real Vim editor, no bundled dependency: CodeMirror 6 and the community
// Vim keybinding layer are pulled from a CDN as ES modules at runtime — the
// same trick secret_prettier.ts uses for Prettier. Nothing is added to
// package.json; the editor core is fetched after the page's `load` event so
// it never blocks first paint.
//
// All the CodeMirror packages are requested from esm.sh with an identical
// pinned `?deps=` set so every module shares ONE @codemirror/state instance
// (a mismatched state singleton is the classic reason CM6 + vim silently
// fails to bind keys).

const V = "6"; // pinned deps so esm.sh dedupes @codemirror/state across modules
const DEPS = `@codemirror/state@${V},@codemirror/view@${V},@codemirror/commands@${V},@codemirror/language@${V}`;
const url = (pkg: string) => `https://esm.sh/${pkg}?deps=${DEPS}`;

const CODEMIRROR_URL = url("codemirror@6");
const VIEW_URL = url("@codemirror/view@6");
const VIM_URL = url("@replit/codemirror-vim@6");

let editorPromise: Promise<{
  view: any;
  container: HTMLElement;
}> | null = null;

const buildEditor = async (
  doc: string,
): Promise<{ view: any; container: HTMLElement }> => {
  const [cm, viewMod, vimMod] = await Promise.all([
    import(/* @vite-ignore */ CODEMIRROR_URL),
    import(/* @vite-ignore */ VIEW_URL),
    import(/* @vite-ignore */ VIM_URL),
  ]);

  const { basicSetup } = cm;
  const { EditorView } = viewMod;
  const { vim, Vim } = vimMod;

  // Make :w a no-op and :q take you back to the secret menu.
  Vim.defineEx("write", "w", () => {});
  Vim.defineEx("quit", "q", () => window.navigate("/secret"));

  const container = document.createElement("div");
  container.className = "vim-cm w-full";

  const view = new EditorView({
    doc,
    // vim() MUST come first so its keymap wins over the default bindings.
    extensions: [vim({ status: true }), basicSetup],
    parent: container,
  });

  return { view, container };
};

const SAMPLE = `Welcome to Vim — the real thing, running in your browser.

This editor is CodeMirror 6 with the community Vim keymap, both loaded
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
    class="w-full max-w-3xl mt-6 bg-stone-900 border border-green-900 focus-within:border-green-600 rounded overflow-hidden">
    <div id="vim-loading" class="px-4 py-16 text-center text-green-800 font-mono text-sm">
      Loading editor…
    </div>
  </div>
</div>
`;

  const host = app.querySelector("#vim-host") as HTMLElement;

  // Build the editor once and reuse it across navigations (preserves the
  // buffer). The CDN import starts here, on first visit to /secret/vim.
  if (!editorPromise) editorPromise = buildEditor(SAMPLE);

  editorPromise
    .then(({ container, view }) => {
      // Guard against the user navigating away before the CDN import resolved.
      if (!document.body.contains(host)) return;
      host.innerHTML = "";
      host.appendChild(container);
      view.focus();
    })
    .catch((err) => {
      const loading = host.querySelector("#vim-loading");
      if (loading)
        loading.textContent =
          "Failed to load the editor from the CDN: " +
          (err instanceof Error ? err.message : String(err));
    });
};
