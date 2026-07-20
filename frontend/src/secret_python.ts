// Client-side Python 3 runner, powered by Pyodide (CPython compiled to WASM),
// pulled from a CDN as an ES module. Nothing is bundled: the (large) Pyodide
// runtime loads after the page's `load` event so it never blocks first paint,
// and it's fetched only once and cached for the life of the page.

const PYODIDE_VERSION = "0.28.3";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`;

let pyodidePromise: Promise<any> | null = null;

const loadPyodideRuntime = (): Promise<any> => {
  if (!pyodidePromise) {
    pyodidePromise = import(/* @vite-ignore */ PYODIDE_URL).then((mod) =>
      mod.loadPyodide({
        indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
      }),
    );
  }
  return pyodidePromise;
};

// Kick off the (large) Pyodide fetch once the page has finished loading, so the
// first Run click doesn't pay the whole download + init cost on top.
const warmUp = () => {
  if (document.readyState === "complete") {
    window.setTimeout(loadPyodideRuntime, 0);
  } else {
    window.addEventListener("load", () => loadPyodideRuntime(), { once: true });
  }
};

const SAMPLE = `import sys

print("Python", sys.version.split()[0])

for n in range(1, 6):
    print(n, "squared is", n * n)
`;

export default (app: HTMLElement) => {
  warmUp();

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Python 3
    </h1>
  </a>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-4">
    <div class="flex flex-wrap gap-2 items-center">
      <button id="py-run"
        class="border border-green-900 hover:border-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-green-300 font-bold px-6 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">
        Run
      </button>
      <button id="py-clear"
        class="border border-green-900 hover:border-green-600 text-green-300 font-bold px-6 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">
        Clear
      </button>
      <span id="py-status" class="text-sm font-mono text-green-800"></span>
    </div>

    <div class="flex w-full h-72 bg-stone-900 border border-green-900 focus-within:border-green-600 overflow-hidden">
      <div id="py-gutter"
        class="select-none text-right text-green-800 font-mono text-sm leading-normal py-3 pl-3 pr-2 overflow-hidden whitespace-pre">1</div>
      <textarea id="py-input" spellcheck="false" placeholder="Write Python 3… (Ctrl/Cmd+Enter to run)"
        class="flex-1 min-w-0 bg-transparent outline-none py-3 pr-3 text-green-300 placeholder-green-900 font-mono text-sm resize-none overflow-auto leading-normal"></textarea>
    </div>

    <pre id="py-output"
      class="w-full min-h-56 bg-stone-900 border border-green-900 px-3 py-3 text-green-300 font-mono text-sm whitespace-pre-wrap wrap-break-word overflow-x-auto"></pre>
  </div>
</div>
`;

  const input = app.querySelector("#py-input") as HTMLTextAreaElement;
  const gutter = app.querySelector("#py-gutter") as HTMLElement;
  const output = app.querySelector("#py-output") as HTMLElement;
  const statusEl = app.querySelector("#py-status") as HTMLElement;
  const runBtn = app.querySelector("#py-run") as HTMLButtonElement;
  const clearBtn = app.querySelector("#py-clear") as HTMLButtonElement;

  input.value = SAMPLE;

  const updateGutter = () => {
    const lineCount = input.value.split("\n").length;
    gutter.textContent = Array.from(
      { length: lineCount },
      (_, i) => i + 1,
    ).join("\n");
    gutter.scrollTop = input.scrollTop;
  };

  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle("text-red-500", isError);
    statusEl.classList.toggle("text-green-800", !isError);
  };

  const run = async () => {
    // The Run button disables itself while running, but Ctrl/Cmd+Enter below
    // calls run() directly and would bypass that — without this guard, rapid
    // keyboard-triggered runs could overlap on the single shared Pyodide
    // interpreter, stomping each other's stdout/stderr redirection mid-flight.
    if (runBtn.disabled) return;
    if (!input.value.trim()) return;

    runBtn.disabled = true;
    setStatus("Loading Python…");

    let buffer = "";
    try {
      const pyodide = await loadPyodideRuntime();
      setStatus("Running…");

      // Route both streams into one buffer so output reads like a terminal.
      buffer = "";
      const write = (s: string) => {
        buffer += s + "\n";
      };
      pyodide.setStdout({ batched: write });
      pyodide.setStderr({ batched: write });

      await pyodide.runPythonAsync(input.value);
      output.textContent = buffer;
      setStatus("");
    } catch (err) {
      // Python tracebacks come through the thrown PythonError message; show any
      // stdout captured before the crash, then the error.
      output.textContent =
        buffer + (err instanceof Error ? err.message : String(err));
      setStatus("Error", true);
    } finally {
      runBtn.disabled = false;
    }
  };

  runBtn.addEventListener("click", run);

  input.addEventListener("input", updateGutter);

  input.addEventListener("scroll", () => {
    gutter.scrollTop = input.scrollTop;
  });

  input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
    // Insert a real tab instead of moving focus, so indentation is easy.
    if (e.key === "Tab") {
      e.preventDefault();
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value =
        input.value.slice(0, start) + "    " + input.value.slice(end);
      input.selectionStart = input.selectionEnd = start + 4;
      updateGutter();
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    output.textContent = "";
    setStatus("");
    updateGutter();
    input.focus();
  });

  updateGutter();
};
