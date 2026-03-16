const MORSE_GROUPS = {
  Letters: {
    "A": ".-", "B": "-...", "C": "-.-.", "D": "-..", "E": ".", "F": "..-.", "G": "--.", "H": "....",
    "I": "..", "J": ".---", "K": "-.-", "L": ".-..", "M": "--", "N": "-.", "O": "---", "P": ".--.",
    "Q": "--.-", "R": ".-.", "S": "...", "T": "-", "U": "..-", "V": "...-", "W": ".--", "X": "-..-",
    "Y": "-.--", "Z": "--.."
  },
  Numbers: {
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....",
    "6": "-....", "7": "--...", "8": "---..", "9": "----."
  }
};

const MORSE_MAP: Record<string, string> = Object.values(MORSE_GROUPS)
  .reduce((acc, group) => ({
    ...acc,
    ...Object.fromEntries(Object.entries(group).map(([k, v]) => [v, k]))
  }), {});

const ALL_CHARS = Object.keys(MORSE_MAP).map(key => ({ code: key, char: MORSE_MAP[key] }));

export default (app: HTMLElement) => {

  const unit = 120;

  let isActive = false;
  let isTraining = false;
  let isChallenge = false;

  let currentTarget: { code: string, char: string } | null = null;

  let score = 0;
  let timeLeft = 60;

  let pressStartTime = 0;

  let letterTimer: number | undefined;
  let wordTimer: number | undefined;
  let gameTimer: number | undefined;

  const Audio = {
    ctx: null as AudioContext | null,
    osc: null as OscillatorNode | null,
    gain: null as GainNode | null,

    start() {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      }

      if (this.ctx.state === "suspended") this.ctx.resume();

      this.osc = this.ctx.createOscillator();
      this.osc.frequency.value = 550;
      this.osc.connect(this.gain!);
      this.osc.start();

      this.gain!.gain.setTargetAtTime(0.15, this.ctx.currentTime, 0.005);
    },

    stop() {
      if (!this.ctx || !this.gain) return;

      this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.005);

      const o = this.osc;
      setTimeout(() => {
        try { o?.stop(); } catch {}
      }, 50);
    },

    close() {
      try { this.ctx?.close(); } catch {}
      this.ctx = null;
    }
  };

  const readHigh = () => {
    try {
      return parseInt(localStorage.getItem("morse-high") || "0") || 0;
    } catch {
      return 0;
    }
  };

  app.innerHTML = `
<div class="flex flex-col items-center justify-center min-h-screen bg-[#050505] text-green-500 font-mono p-4">

<div id="stats-bar" class="hidden w-full max-w-lg mb-4 flex justify-between px-4 py-2 border border-yellow-600/30 rounded text-xs uppercase">
<div>Time: <span id="timer">60</span>s</div>
<div>Score: <span id="score">0</span></div>
<div>Best: <span id="high-score">${readHigh()}</span></div>
</div>

<div id="drill-box" class="hidden w-full max-w-lg mb-4 p-4 border border-green-500/30 rounded text-center">
<div class="text-[10px] uppercase mb-1">Send this signal:</div>
<div id="target-display" class="text-6xl font-bold text-white mb-1">A</div>
<div id="target-code" class="text-xs tracking-[0.5em]">.-</div>
</div>

<div class="w-full max-w-lg space-y-4">

<div class="flex gap-2">
<button id="toggle-drill" class="flex-1 text-xs border border-green-900 px-2 py-2">Drill</button>
<button id="start-challenge" class="flex-1 text-xs border border-yellow-900 px-2 py-2">60s</button>
</div>

<div class="bg-black border border-green-500/20 p-6 rounded">

<div id="msg"
aria-live="polite"
aria-label="Decoded Morse output"
class="text-2xl min-h-[3rem] break-all text-green-50"></div>

<div id="buffer"
aria-live="polite"
aria-label="Current Morse buffer"
class="text-4xl h-12 text-yellow-500 mt-2 font-bold tracking-widest"></div>

</div>

<button id="keyer"
aria-label="Morse keyer press and hold"
role="button"
class="w-full h-44 border border-green-500/20 rounded-2xl flex items-center justify-center">

<div id="light" class="w-10 h-10 rounded-full bg-green-900"></div>

</button>

</div>
</div>
`;

  const msgEl = app.querySelector("#msg") as HTMLElement;
  const bufEl = app.querySelector("#buffer") as HTMLElement;
  const drillBox = app.querySelector("#drill-box") as HTMLElement;
  const statsBar = app.querySelector("#stats-bar") as HTMLElement;

  const targetDisplay = app.querySelector("#target-display") as HTMLElement;
  const targetCode = app.querySelector("#target-code") as HTMLElement;

  const timerEl = app.querySelector("#timer") as HTMLElement;
  const scoreEl = app.querySelector("#score") as HTMLElement;
  const highScoreEl = app.querySelector("#high-score") as HTMLElement;

  const nextDrill = () => {
    currentTarget = ALL_CHARS[Math.floor(Math.random() * ALL_CHARS.length)];
    targetDisplay.textContent = currentTarget.char;
    targetCode.textContent = currentTarget.code;
  };

  const endChallenge = () => {

    isChallenge = false;
    isTraining = false;

    if (gameTimer) clearInterval(gameTimer);

    const best = readHigh();

    if (score > best) {
      localStorage.setItem("morse-high", score.toString());
      highScoreEl.textContent = score.toString();
    }

    alert(`Challenge Over\nScore: ${score}`);

    drillBox.classList.add("hidden");
    statsBar.classList.add("hidden");

    score = 0;
  };

  const commit = () => {

    const code = bufEl.textContent || "";
    if (!code) return;

    const char = MORSE_MAP[code] || "?";

    if ((isTraining || isChallenge) && currentTarget) {

      if (code === currentTarget.code) {

        score++;

        if (isChallenge)
          scoreEl.textContent = score.toString();

        bufEl.textContent = "";

        nextDrill();

      } else {

        bufEl.classList.add("text-red-500");

        setTimeout(() => {
          bufEl.textContent = "";
          bufEl.classList.remove("text-red-500");
        }, 300);
      }

    } else {

      msgEl.textContent += char;
      bufEl.textContent = "";

      if (wordTimer) clearTimeout(wordTimer);

      wordTimer = window.setTimeout(() => {
        msgEl.textContent += " ";
      }, unit * 7);
    }
  };

  const backspace = () => {

    if (bufEl.textContent && bufEl.textContent.length > 0) {
      bufEl.textContent = bufEl.textContent.slice(0, -1);
      return;
    }

    if (msgEl.textContent)
      msgEl.textContent = msgEl.textContent.slice(0, -1);
  };

  const start = (e?: Event) => {

    e?.preventDefault();

    if (isActive) return;

    isActive = true;

    if (letterTimer) clearTimeout(letterTimer);
    if (wordTimer) clearTimeout(wordTimer);

    pressStartTime = performance.now();

    Audio.start();

    app.querySelector("#light")!.classList.add("bg-green-400");
  };

  const end = (e?: Event) => {

    e?.preventDefault();

    if (!isActive) return;

    isActive = false;

    Audio.stop();

    app.querySelector("#light")!.classList.remove("bg-green-400");

    const dur = performance.now() - pressStartTime;

    if (dur > 20) {

      bufEl.textContent += (dur > unit * 1.75 ? "-" : ".");

      if (letterTimer) clearTimeout(letterTimer);

      letterTimer = window.setTimeout(commit, unit * 3);
    }
  };

  app.querySelector("#start-challenge")!.addEventListener("click", () => {

    isChallenge = true;
    isTraining = true;

    timeLeft = 60;
    score = 0;

    scoreEl.textContent = "0";
    timerEl.textContent = "60";

    drillBox.classList.remove("hidden");
    statsBar.classList.remove("hidden");

    nextDrill();

    if (gameTimer) clearInterval(gameTimer);

    gameTimer = window.setInterval(() => {

      timeLeft--;

      timerEl.textContent = timeLeft.toString();

      if (timeLeft <= 0)
        endChallenge();

    }, 1000);
  });

  app.querySelector("#toggle-drill")!.addEventListener("click", () => {

    isTraining = !isTraining;

    if (gameTimer) clearInterval(gameTimer);

    drillBox.classList.toggle("hidden", !isTraining);
    statsBar.classList.add("hidden");

    if (isTraining)
      nextDrill();
  });

  window.addEventListener("keydown", e => {

    if (e.key === " " && !e.repeat) {
      e.preventDefault();
      start(e);
    }

    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      backspace();
    }
  });

  window.addEventListener("keyup", e => {

    if (e.key === " ")
      end(e);
  });

  const keyer = app.querySelector("#keyer")!;

  keyer.addEventListener("mousedown", start);
  keyer.addEventListener("mouseup", end);
  keyer.addEventListener("mouseleave", end);

  keyer.addEventListener("touchstart", start, { passive: false });
  keyer.addEventListener("touchend", end, { passive: false });
  keyer.addEventListener("touchcancel", end, { passive: false });

  return () => {

    Audio.close();

    if (gameTimer) clearInterval(gameTimer);
    if (letterTimer) clearTimeout(letterTimer);
    if (wordTimer) clearTimeout(wordTimer);
  };
};
