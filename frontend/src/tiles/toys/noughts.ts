import "./noughts.css";
import { $, $$ } from "../dom";
import { pixelHtml } from "../pixels";
import { rng, type Rng, type Toy } from "../toy";

interface BoardNode {
  winner: number;
  height: number;
  parent: BoardNode | null;
  index: number;
  kids: BoardNode[];
  el: HTMLElement;
}

const NOBODY = 0;
const X = 1;
const O = 2;
const DRAWN = 3;
const THINK_MS = 380;
const LOOK_AHEAD_LIMIT = 81;
const SURE_WIN = 1e9;
const TIE = 1e-9;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
const GAPS: Record<number, number[]> = {
  1: [0, 6],
  2: [0, 2, 10],
  3: [0, 1, 3, 8],
};
const WORTH = [1, 14, 200, 3000];

const MARKUP = `
  <div class="toy-bar">
    <div class="seg" role="group" aria-label="Opponent">
      <button class="btn" type="button" data-mode="cpu">vs computer</button>
      <button class="btn" type="button" data-mode="two">2 players</button>
    </div>
    <div class="seg" role="group" aria-label="Board depth">
      <button class="btn" type="button" data-depth="1">3×3</button>
      <button class="btn" type="button" data-depth="2">super</button>
      <button class="btn" type="button" data-depth="3">super³</button>
    </div>
    <button class="btn" type="button" data-restart>Restart</button>
    <span class="tag" id="ttt-status" aria-live="polite"></span>
  </div>
  <div class="ttt-wrap field"><div class="ttt snap" id="ttt"></div></div>
`;

const other = (player: number): number => X + O - player;
const letter = (player: number): string => (player === X ? "X" : "O");

const CROSS = ["##...##", "###.###", ".#####.", "..###..", ".#####.", "###.###", "##...##"];
const NOUGHT = [".#####.", "#######", "##...##", "##...##", "##...##", "#######", ".#####."];

const markHtml = (player: number): string =>
  `<span class="px">${pixelHtml(player === X ? CROSS : NOUGHT)}</span>`;

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const board = $("#ttt", host.body);
  const status = $("#ttt-status", host.body);
  const modeButtons = $$("[data-mode]", host.body);
  const depthButtons = $$("[data-depth]", host.body);
  const cells = new WeakMap<EventTarget, BoardNode>();

  let depth = 1;
  let cpu = true;
  let turn = X;
  let over = false;
  let thinking = false;
  let run = 0;
  let seed = 1;
  let random: Rng = Math.random;

  const make = (height: number, parent: BoardNode | null, index: number): BoardNode => {
    const el = document.createElement(height ? "div" : "button");
    const node: BoardNode = { winner: NOBODY, height, parent, index, kids: [], el };
    if (el instanceof HTMLButtonElement) {
      el.type = "button";
      el.className = "c";
      cells.set(el, node);
      return node;
    }
    el.className = "b";
    el.style.gap = `${GAPS[depth][height]}px`;
    el.style.setProperty("--s", String(3 ** height));
    for (let i = 0; i < 9; i++) {
      const kid = make(height - 1, node, i);
      node.kids.push(kid);
      el.append(kid.el);
    }
    return node;
  };

  let root = make(depth, null, 0);
  let target: BoardNode | null = root;

  const judge = (node: BoardNode): number => {
    for (const [a, b, c] of LINES) {
      const winner = node.kids[a].winner;
      const taken = winner === X || winner === O;
      if (taken && winner === node.kids[b].winner && winner === node.kids[c].winner) {
        return winner;
      }
    }
    return node.kids.every((kid) => kid.winner) ? DRAWN : NOBODY;
  };

  const play = (leaf: BoardNode, player: number): BoardNode[] => {
    const decided = [leaf];
    leaf.winner = player;
    for (let node = leaf.parent; node; node = node.parent) {
      const winner = judge(node);
      if (!winner) break;
      node.winner = winner;
      decided.push(node);
    }
    return decided;
  };

  const unplay = (decided: BoardNode[]): void => {
    for (const node of decided) node.winner = NOBODY;
  };

  const aim = (leaf: BoardNode): BoardNode => {
    const path: number[] = [];
    for (let node = leaf; node.parent; node = node.parent) path.unshift(node.index);
    let node = root;
    for (const index of path.slice(1)) {
      const kid = node.kids[index];
      if (kid.winner) break;
      node = kid;
    }
    return node;
  };

  const moves = (within: BoardNode): BoardNode[] => {
    const free: BoardNode[] = [];
    const collect = (node: BoardNode): void => {
      if (node.winner) return;
      if (node.height) node.kids.forEach(collect);
      else free.push(node);
    };
    collect(within);
    return free;
  };

  const lineValue = (node: BoardNode, line: number[], me: number): number => {
    let mine = 0;
    let theirs = 0;
    for (const index of line) {
      const winner = node.kids[index].winner;
      if (winner === DRAWN) return 0;
      if (winner === me) mine++;
      else if (winner === other(me)) theirs++;
    }
    let total = 0;
    if (mine && !theirs) total += WORTH[node.height] * (mine === 2 ? 0.3 : 0.04);
    if (theirs && !mine) total -= WORTH[node.height] * (theirs === 2 ? 0.3 : 0.04);
    return total;
  };

  const value = (node: BoardNode, me: number): number => {
    if (node.winner === me) return WORTH[node.height];
    if (node.winner === other(me)) return -WORTH[node.height];
    if (node.winner === DRAWN || !node.height) return 0;
    let total = 0;
    for (const kid of node.kids) total += value(kid, me);
    for (const line of LINES) total += lineValue(node, line, me);
    return total;
  };

  const minimax = (player: number): number => {
    if (root.winner === O) return 1;
    if (root.winner === X) return -1;
    if (root.winner === DRAWN) return 0;
    let best = player === O ? -2 : 2;
    for (const kid of root.kids) {
      if (kid.winner) continue;
      const decided = play(kid, player);
      const result = minimax(other(player));
      unplay(decided);
      best = player === O ? Math.max(best, result) : Math.min(best, result);
    }
    return best;
  };

  const worstReply = (move: BoardNode): number => {
    let worst = Infinity;
    for (const reply of moves(aim(move))) {
      const decided = play(reply, X);
      const result = root.winner === X ? -SURE_WIN : value(root, O);
      unplay(decided);
      if (result < worst) worst = result;
    }
    return worst;
  };

  const score = (move: BoardNode, lookAhead: boolean): number => {
    if (depth === 1) return minimax(X);
    if (root.winner === O) return SURE_WIN;
    if (root.winner || !lookAhead) return value(root, O);
    return worstReply(move);
  };

  const think = (within: BoardNode): BoardNode => {
    const mine = moves(within);
    const lookAhead = mine.length <= LOOK_AHEAD_LIMIT;
    let best: BoardNode[] = [];
    let top = -Infinity;
    for (const move of mine) {
      const decided = play(move, O);
      const result = score(move, lookAhead);
      unplay(decided);
      if (result > top + TIE) {
        top = result;
        best = [move];
      } else if (Math.abs(result - top) <= TIE) {
        best.push(move);
      }
    }
    return best[Math.floor(random() * best.length)];
  };

  const mark = (node: BoardNode): void => {
    if (node.el instanceof HTMLButtonElement) {
      node.el.innerHTML = markHtml(node.winner);
      node.el.setAttribute("aria-label", letter(node.winner));
      node.el.classList.add(node.winner === X ? "x" : "o");
      node.el.disabled = true;
    } else if (node !== root) {
      const cover = document.createElement("div");
      cover.className = node.winner === X ? "b-won x" : node.winner === DRAWN ? "b-won" : "b-won o";
      if (node.winner !== DRAWN) cover.innerHTML = markHtml(node.winner);
      node.el.append(cover);
      node.el.classList.add("done");
    }
  };

  const statusText = (): string => {
    if (!over) {
      if (!cpu) return `${letter(turn)} to move`;
      return turn === X ? "Your move" : "Thinking";
    }
    if (root.winner === DRAWN) return "Draw";
    if (!cpu) return `${letter(root.winner)} wins`;
    return root.winner === X ? "You win" : "Computer wins";
  };

  const refresh = (): void => {
    board.querySelector(".live")?.classList.remove("live");
    target?.el.classList.add("live");
    status.textContent = statusText();
    for (const button of modeButtons) {
      const pressed = (button.dataset.mode === "cpu") === cpu;
      button.setAttribute("aria-pressed", String(pressed));
    }
    for (const button of depthButtons) {
      const pressed = Number(button.dataset.depth) === depth;
      button.setAttribute("aria-pressed", String(pressed));
    }
  };

  const answer = (): void => {
    const me = run;
    thinking = true;
    host.later(THINK_MS, () => {
      if (me !== run || !target) return;
      thinking = false;
      move(think(target));
    });
  };

  function move(leaf: BoardNode): void {
    play(leaf, turn).forEach(mark);
    board.querySelector(".last")?.classList.remove("last");
    leaf.el.classList.add("last");
    if (root.winner) {
      over = true;
      target = null;
    } else {
      target = aim(leaf);
      turn = other(turn);
    }
    refresh();
    if (!over && cpu && turn === O) answer();
  }

  const reset = (): void => {
    run++;
    thinking = false;
    random = rng(seed);
    root = make(depth, null, 0);
    turn = X;
    target = root;
    over = false;
    board.style.setProperty("--n", String(3 ** depth));
    board.replaceChildren(root.el);
    root.el.classList.add("root");
    refresh();
  };

  const insideTarget = (cell: BoardNode): boolean => {
    let inside = false;
    for (let node = cell.parent; node; node = node.parent) {
      if (node.winner) return false;
      if (node === target) inside = true;
    }
    return inside;
  };

  board.addEventListener("click", (event) => {
    const cell = event.target && cells.get(event.target);
    if (!cell || cell.winner || over || thinking || (cpu && turn === O)) return;
    if (insideTarget(cell)) move(cell);
  });

  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      cpu = button.dataset.mode === "cpu";
      reset();
    });
  }
  for (const button of depthButtons) {
    button.addEventListener("click", () => {
      depth = Number(button.dataset.depth);
      reset();
    });
  }

  host.onSeed((next) => {
    seed = next;
    reset();
  });
};

export default toy;
