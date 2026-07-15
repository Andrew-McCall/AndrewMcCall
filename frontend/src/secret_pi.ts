// Pi Tester. Type the digits of pi in order, from a keypad or the number row;
// a wrong digit flashes red and resets the run. The best run persists in
// localStorage. The hint (the next expected digit) is hidden by default so it
// stays a test — tap it or "Toggle hint" to peek.
//
// Registers a window `keydown` listener, so it exports `disposePi` for the
// router to call on navigation away (see main.ts), mirroring the canvas and
// visits pages — otherwise number keys would keep driving this page after the
// SPA has moved on.

const PI =
  "3.141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067982148086513282306647093844609550582231725359408128481117450284102701938521105559644622948954930381964428810975665933446128475648233786783165271201909145648566923460348610454326648213393607260249141273724587006606315588174881520920962829254091715364367892590360011330530548820466521384146951941511609433057270365759591953092186117381932611793105118548074462379962749567351885752724891227938183011949129833673362440656643086021394946395224737190702179860943702770539217176293176752384674818467669405132000568127145263560827785771342757789609173637178721468440901224953430146549585371050792279689258923542019956112129021960864034418159813629774771309960518707211349999998372978049951059731732816096318595024459455346908302642522308253344685035261931188171010003137838752886587533208381420617177669147303598253490428755468731159562863882353787593751957781857780532171226806613001927876611195909216420198938095257201065485";

const HIGH_KEY = "pi-high";

const readHigh = (): number => {
  try {
    return parseInt(localStorage.getItem(HIGH_KEY) || "0") || 0;
  } catch {
    return 0;
  }
};

// Module-scoped so the router can detach the window listener on navigation away.
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function disposePi(): void {
  if (onKey) window.removeEventListener("keydown", onKey);
  onKey = null;
}

export default (app: HTMLElement) => {
  disposePi(); // drop any listener from a previous visit

  let index = 2; // PI[0]="3", PI[1]=".", so digits start at 2
  let score = 0;
  let high = readHigh();
  let showHint = false;

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Pi Tester
    </h1>
  </a>

  <div class="w-full max-w-sm mt-8 flex flex-col items-center gap-4">
    <p id="pi-progress" class="w-full text-center font-mono text-green-300 break-all min-h-8 leading-8">3.</p>

    <button id="pi-hint" title="Click to reveal the next digit"
      class="font-mono text-3xl text-green-400 h-12 w-12 flex items-center justify-center rounded border border-green-900 hover:border-green-600 cursor-pointer transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">
      <span class="opacity-0">0</span>
    </button>
    <p class="text-green-800 text-sm -mt-2">next digit</p>

    <div class="flex gap-6 text-sm font-mono text-green-800">
      <div>Correct: <span id="pi-score" class="text-green-400">0</span></div>
      <div>Best: <span id="pi-high" class="text-green-400">${high}</span></div>
    </div>

    <div class="grid grid-cols-3 gap-2 w-full">
      <button data-key="1" class="pi-pad">1</button>
      <button data-key="2" class="pi-pad">2</button>
      <button data-key="3" class="pi-pad">3</button>
      <button data-key="4" class="pi-pad">4</button>
      <button data-key="5" class="pi-pad">5</button>
      <button data-key="6" class="pi-pad">6</button>
      <button data-key="7" class="pi-pad">7</button>
      <button data-key="8" class="pi-pad">8</button>
      <button data-key="9" class="pi-pad">9</button>
      <button data-key="0" class="pi-pad col-span-3">0</button>
    </div>

    <button id="pi-toggle" class="w-full text-green-700 hover:text-green-400 text-sm cursor-pointer">Toggle hint</button>
  </div>
</div>`;

  // Shared keypad styling, applied here so the markup above stays readable.
  app.querySelectorAll<HTMLButtonElement>(".pi-pad").forEach((b) => {
    b.className =
      "pi-pad bg-green-800 hover:bg-green-700 active:bg-green-900 text-white text-xl py-3 rounded cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950" +
      (b.classList.contains("col-span-3") ? " col-span-3" : "");
  });

  const progressEl = app.querySelector<HTMLParagraphElement>("#pi-progress")!;
  const hintEl = app.querySelector<HTMLButtonElement>("#pi-hint")!;
  const scoreEl = app.querySelector<HTMLSpanElement>("#pi-score")!;
  const highEl = app.querySelector<HTMLSpanElement>("#pi-high")!;

  const renderHint = () => {
    const next = PI[index] ?? "";
    hintEl.innerHTML = showHint
      ? next
      : `<span class="opacity-0">${next || "0"}</span>`;
  };

  const toggleHint = () => {
    showHint = !showHint;
    renderHint();
  };

  const reset = () => {
    index = 2;
    score = 0;
    scoreEl.textContent = "0";
    // Keep only the last stretch visible so the line never overflows the card.
    progressEl.textContent = "3.";
    renderHint();
  };

  // Blocks input while the wrong-answer flash is showing, so a burst of keys
  // typed during the 700ms pause can't stack up multiple overlapping resets.
  let locked = false;

  const handleInput = (key: string) => {
    if (locked) return;
    if (key === PI[index]) {
      score++;
      index++;
      scoreEl.textContent = score.toString();
      // Show a trailing window of the digits entered so far so the line never
      // overflows the card; ellipsis only once we've actually truncated.
      const start = Math.max(2, index - 40);
      progressEl.textContent = (start > 2 ? "…" : "3.") + PI.slice(start, index);
      if (score > high) {
        high = score;
        highEl.textContent = high.toString();
        try {
          localStorage.setItem(HIGH_KEY, high.toString());
        } catch {
          /* no persistence available */
        }
      }
      renderHint();
    } else {
      // Flash the wrong entry red instead of a jarring alert, then reset.
      locked = true;
      progressEl.classList.add("text-red-500");
      progressEl.textContent = `✗ expected ${PI[index]}`;
      setTimeout(() => {
        progressEl.classList.remove("text-red-500");
        reset();
        locked = false;
      }, 700);
    }
  };

  hintEl.onclick = toggleHint;
  app.querySelector<HTMLButtonElement>("#pi-toggle")!.onclick = toggleHint;
  app.querySelectorAll<HTMLButtonElement>(".pi-pad").forEach((b) => {
    b.onclick = () => handleInput(b.dataset.key!);
  });

  onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === "r") return reset();
    if (e.key === " ") {
      e.preventDefault();
      return toggleHint();
    }
    if (e.key >= "0" && e.key <= "9") return handleInput(e.key);
  };
  window.addEventListener("keydown", onKey);

  renderHint();
};
