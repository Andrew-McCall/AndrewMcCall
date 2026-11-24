import "./rps.css";
import { $, $$, calm } from "../dom";
import { pixelHtml } from "../pixels";
import { rng, type Rng, type Toy } from "../toy";

type Hand = "rock" | "paper" | "scissors" | "lizard" | "spock";
type Counts = Partial<Record<Hand, number>>;

const HANDS: Hand[] = ["rock", "paper", "scissors", "lizard", "spock"];
const ROLL_MS = 70;
const ROLL_STEPS = 6;
const RANDOM_SHARE = 0.35;

const ART: Record<Hand, string[]> = {
  rock: [
    ".........",
    "..#####..",
    ".#######.",
    "#########",
    "#########",
    "#########",
    ".#######.",
    "..#####..",
    ".........",
  ],
  paper: [
    ".#####...",
    ".######..",
    ".#######.",
    ".##...##.",
    ".#######.",
    ".##...##.",
    ".#######.",
    ".##...##.",
    ".#######.",
  ],
  scissors: [
    "#.......#",
    "##.....##",
    ".##...##.",
    "..##.##..",
    "...###...",
    "..##.##..",
    ".#.#.#.#.",
    ".#.#.#.#.",
    "..#...#..",
  ],
  lizard: [
    "....#....",
    "...###...",
    ".#.###.#.",
    "..#####..",
    "...###...",
    "..#####..",
    ".#.###.#.",
    "....#....",
    ".....##..",
  ],
  spock: [
    ".#.#.#.#.",
    ".#.#.#.#.",
    ".###.###.",
    ".###.###.",
    "#.######.",
    "########.",
    ".#######.",
    "..#####..",
    "..#####..",
  ],
};

const BEATS: Record<Hand, Partial<Record<Hand, string>>> = {
  rock: { scissors: "blunts", lizard: "crushes" },
  paper: { rock: "covers", spock: "disproves" },
  scissors: { paper: "cut", lizard: "decapitate" },
  lizard: { spock: "poisons", paper: "eats" },
  spock: { scissors: "smashes", rock: "vaporises" },
};

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <div class="seg" role="group" aria-label="Game">
      <button class="btn" type="button" data-rps="3">classic</button>
      <button class="btn" type="button" data-rps="5">lizard Spock</button>
    </div>
    <span class="tag" id="rps-score">you 0 · draws 0 · computer 0</span>
  </div>
  <div class="rps-arena field">
    <div class="hand" id="rps-you"><span class="tag">you</span><div class="px"></div></div>
    <span class="tag">vs</span>
    <div class="hand" id="rps-cpu">
      <span class="tag">computer</span><div class="px"></div>
    </div>
  </div>
  <p class="lede" id="rps-say" aria-live="polite">Pick one.</p>
  <div class="rps-pick" id="rps-pick"></div>
`;

const capital = (word: string): string => word[0].toUpperCase() + word.slice(1);
const spoken = (hand: Hand): string => (hand === "spock" ? "Spock" : hand);

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const you = $("#rps-you", host.body);
  const bot = $("#rps-cpu", host.body);
  const yourArt = $(".px", you);
  const botArt = $(".px", bot);
  const say = $("#rps-say", host.body);
  const scoreLabel = $("#rps-score", host.body);
  const pick = $("#rps-pick", host.body);
  const modeButtons = $$("[data-rps]", host.body);
  const still = calm();

  let mode = 3;
  let names: Hand[] = [];
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let last: Hand | null = null;
  let seen: Partial<Record<Hand, Counts>> = {};
  let busy = false;
  let seed = 1;
  let random: Rng = Math.random;
  let run = 0;

  const draw = (el: HTMLElement, hand?: Hand): void => {
    el.innerHTML = hand ? pixelHtml(ART[hand]) : "";
  };

  const tally = (): void => {
    scoreLabel.textContent = `you ${wins} · draws ${draws} · computer ${losses}`;
  };

  const any = (list: Hand[]): Hand => list[Math.floor(random() * list.length)];

  const guess = (): Hand => {
    const row = last && seen[last];
    if (!row || random() < RANDOM_SHARE) return any(names);
    const likely = names.reduce((a, b) => ((row[b] || 0) > (row[a] || 0) ? b : a));
    return any(names.filter((name) => BEATS[name][likely]));
  };

  const remember = (mine: Hand): void => {
    if (last) {
      const row = seen[last] ?? {};
      row[mine] = (row[mine] || 0) + 1;
      seen[last] = row;
    }
    last = mine;
  };

  const clearWinner = (): void => {
    you.classList.remove("won");
    bot.classList.remove("won");
  };

  const reveal = (mine: Hand, theirs: Hand): void => {
    draw(botArt, theirs);
    if (mine === theirs) {
      draws++;
      say.textContent = `Both ${spoken(mine)}. Draw.`;
    } else if (BEATS[mine][theirs]) {
      wins++;
      you.classList.add("won");
      say.textContent =
        `${capital(mine)} ${BEATS[mine][theirs]} ${spoken(theirs)}. You win.`;
    } else {
      losses++;
      bot.classList.add("won");
      say.textContent =
        `${capital(theirs)} ${BEATS[theirs][mine]} ${spoken(mine)}. Computer wins.`;
    }
    tally();
    busy = false;
  };

  const roll = (mine: Hand, theirs: Hand): void => {
    const me = run;
    let step = 0;
    const stop = host.every(ROLL_MS, () => {
      if (me !== run) return stop();
      draw(botArt, names[step % names.length]);
      step++;
      if (step > ROLL_STEPS) {
        stop();
        reveal(mine, theirs);
      }
    });
  };

  const play = (mine: Hand): void => {
    if (busy) return;
    busy = true;
    const theirs = guess();
    remember(mine);
    clearWinner();
    draw(yourArt, mine);
    say.textContent = "…";
    if (still) reveal(mine, theirs);
    else roll(mine, theirs);
  };

  const pickButton = (hand: Hand): HTMLButtonElement => {
    const button = document.createElement("button");
    const art = document.createElement("span");
    button.className = "btn";
    button.type = "button";
    art.className = "px";
    draw(art, hand);
    button.append(art, capital(hand));
    button.addEventListener("click", () => play(hand));
    return button;
  };

  const reset = (): void => {
    run++;
    random = rng(seed);
    busy = false;
    names = HANDS.slice(0, mode);
    wins = 0;
    draws = 0;
    losses = 0;
    last = null;
    seen = {};
    clearWinner();
    draw(yourArt);
    draw(botArt);
    pick.replaceChildren(...names.map(pickButton));
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.rps) === mode));
    }
    say.textContent = "Pick one.";
    tally();
  };

  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      mode = Number(button.dataset.rps);
      reset();
    });
  }

  host.onSeed((next) => {
    seed = next;
    reset();
  });
};

export default toy;
