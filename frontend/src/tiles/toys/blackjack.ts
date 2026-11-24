import "./blackjack.css";
import { $, $$, calm } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

interface Card {
  rank: string;
  suit: string;
}

type Phase = "idle" | "deal" | "play" | "wait" | "dealer";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠︎", "♥︎", "♦︎", "♣︎"];
const RED_SUITS = ["♥", "♦"];
const START_BANK = 100;
const RESHUFFLE_BELOW = 12;
const DEALER_STANDS_ON = 17;
const DEAL_MS = 280;
const REVEAL_MS = 480;

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <div class="seg" role="group" aria-label="Bet">
      <button class="btn" type="button" data-bet="5">5</button>
      <button class="btn" type="button" data-bet="10">10</button>
      <button class="btn" type="button" data-bet="25">25</button>
    </div>
    <span class="tag" id="bj-bank"></span>
  </div>
  <div class="bj field">
    <div class="bj-deck" aria-hidden="true"></div>
    <div class="bj-hand">
      <span class="tag" id="bj-dl">dealer</span>
      <div class="bj-cards" id="bj-d"></div>
    </div>
    <div class="bj-hand">
      <span class="tag" id="bj-pl">you</span>
      <div class="bj-cards" id="bj-p"></div>
    </div>
    <p class="bj-say" id="bj-say" aria-live="polite">Deal to start.</p>
  </div>
  <div class="bj-acts">
    <button class="btn" id="bj-deal" type="button">Deal</button>
    <button class="btn" id="bj-hit" type="button">Hit</button>
    <button class="btn" id="bj-stand" type="button">Stand</button>
    <button class="btn" id="bj-double" type="button">Double</button>
  </div>
`;

const cardValue = (card: Card): number => {
  if (card.rank === "A") return 11;
  return Number(card.rank) || 10;
};

const total = (hand: Card[]): number => {
  let sum = 0;
  let aces = 0;
  for (const card of hand) {
    sum += cardValue(card);
    if (card.rank === "A") aces++;
  }
  while (sum > 21 && aces) {
    sum -= 10;
    aces--;
  }
  return sum;
};

export interface Outcome {
  text: string;
  pays: number;
}

export function outcome(
  mine: number,
  theirs: number,
  playerTwoCards: boolean,
  dealerTwoCards: boolean,
): Outcome {
  const natural = mine === 21 && playerTwoCards;
  const dealerNatural = theirs === 21 && dealerTwoCards;
  if (mine > 21) return { text: "Bust.", pays: 0 };
  if (natural && !dealerNatural) return { text: "Blackjack.", pays: 2.5 };
  if (theirs > 21) return { text: "Dealer busts. You win.", pays: 2 };
  if (mine > theirs) return { text: "You win.", pays: 2 };
  if (mine < theirs) return { text: "Dealer wins.", pays: 0 };
  return { text: "Push.", pays: 1 };
}

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const dealerCards = $("#bj-d", host.body);
  const playerCards = $("#bj-p", host.body);
  const dealerLabel = $("#bj-dl", host.body);
  const playerLabel = $("#bj-pl", host.body);
  const bankLabel = $("#bj-bank", host.body);
  const deck = $(".bj-deck", host.body);
  const say = $("#bj-say", host.body);
  const dealButton = $<HTMLButtonElement>("#bj-deal", host.body);
  const hitButton = $<HTMLButtonElement>("#bj-hit", host.body);
  const standButton = $<HTMLButtonElement>("#bj-stand", host.body);
  const doubleButton = $<HTMLButtonElement>("#bj-double", host.body);
  const betButtons = $$<HTMLButtonElement>("[data-bet]", host.body);
  const still = calm();

  let random: Rng = Math.random;
  let shoe: Card[] = [];
  let bank = START_BANK;
  let bet = 10;
  let stake = 0;
  let player: Card[] = [];
  let dealer: Card[] = [];
  let phase: Phase = "idle";
  let run = 0;
  let hole: HTMLElement | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => host.later(still ? 0 : ms, resolve));

  const shuffle = (): void => {
    shoe = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) shoe.push({ rank, suit });
    }
    for (let i = shoe.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
  };

  const dealerText = (): string => {
    if (!dealer.length) return "dealer";
    const holeHidden = phase === "play" || phase === "deal";
    return `dealer · ${total(holeHidden ? dealer.slice(0, 1) : dealer)}`;
  };

  const canDouble = (): boolean =>
    phase === "play" && player.length === 2 && bank >= stake;

  const paint = (): void => {
    playerLabel.textContent = player.length ? `you · ${total(player)}` : "you";
    dealerLabel.textContent = dealerText();
    bankLabel.textContent = `bank ${bank} · bet ${Math.min(bet, bank)}`;
    dealButton.disabled = phase !== "idle" || bank <= 0;
    hitButton.disabled = phase !== "play";
    standButton.disabled = phase !== "play";
    doubleButton.disabled = !canDouble();
    for (const button of betButtons) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.bet) === bet));
      button.disabled = phase !== "idle";
    }
  };

  const tell = (text: string): void => {
    say.textContent = text;
    say.classList.remove("pop");
    void say.offsetWidth;
    say.classList.add("pop");
  };

  const cardElement = (card: Card): HTMLElement => {
    const el = document.createElement("div");
    el.className = RED_SUITS.includes(card.suit[0]) ? "card red" : "card";
    el.innerHTML =
      `<div class="f"><span>${card.rank}</span><span>${card.suit}</span></div>` +
      `<div class="bk"></div>`;
    return el;
  };

  const flyFromDeck = (el: HTMLElement): void => {
    const from = deck.getBoundingClientRect();
    const to = el.getBoundingClientRect();
    el.style.setProperty("--dx", `${from.left - to.left}px`);
    el.style.setProperty("--dy", `${from.top - to.top}px`);
    el.style.transition = "none";
    el.classList.add("in");
    void el.offsetWidth;
    el.style.transition = "";
    el.classList.remove("in");
  };

  const give = async (
    hand: Card[],
    row: HTMLElement,
    faceDown = false,
  ): Promise<HTMLElement> => {
    if (shoe.length < RESHUFFLE_BELOW) shuffle();
    const card = shoe.pop()!;
    const el = cardElement(card);
    hand.push(card);
    row.append(el);
    flyFromDeck(el);
    if (faceDown) el.classList.add("down");
    paint();
    await sleep(DEAL_MS);
    return el;
  };

  const clearTable = (): void => {
    player = [];
    dealer = [];
    playerCards.replaceChildren();
    dealerCards.replaceChildren();
    playerCards.classList.remove("shake");
  };

  const showHole = (): void => {
    hole?.classList.remove("down");
  };

  const settle = (): void => {
    const result = outcome(
      total(player),
      total(dealer),
      player.length === 2,
      dealer.length === 2,
    );
    if (result.text === "Bust.") playerCards.classList.add("shake");
    bank += stake * result.pays;
    const text = result.text;
    bank = Math.floor(bank);
    phase = "idle";
    tell(bank <= 0 ? `${text} Out of chips.` : text);
    paint();
  };

  const stand = async (): Promise<void> => {
    const me = run;
    phase = "dealer";
    paint();
    showHole();
    await sleep(REVEAL_MS);
    while (me === run && total(dealer) < DEALER_STANDS_ON) {
      await give(dealer, dealerCards);
    }
    if (me === run) settle();
  };

  const deal = async (): Promise<void> => {
    if (phase !== "idle" || bank <= 0) return;
    const me = ++run;
    stake = Math.min(bet, bank);
    bank -= stake;
    clearTable();
    phase = "deal";
    say.textContent = "";
    await give(player, playerCards);
    if (me !== run) return;
    await give(dealer, dealerCards);
    if (me !== run) return;
    await give(player, playerCards);
    if (me !== run) return;
    hole = await give(dealer, dealerCards, true);
    if (me !== run) return;
    phase = "play";
    paint();
    if (total(player) === 21) stand();
  };

  const hit = async (doubled: boolean): Promise<void> => {
    if (phase !== "play") return;
    const me = run;
    phase = "wait";
    await give(player, playerCards);
    if (me !== run) return;
    if (total(player) > 21) {
      showHole();
      settle();
      return;
    }
    if (doubled || total(player) === 21) {
      stand();
      return;
    }
    phase = "play";
    paint();
  };

  const double = (): void => {
    if (!canDouble()) return;
    bank -= stake;
    stake *= 2;
    hit(true);
  };

  dealButton.addEventListener("click", deal);
  hitButton.addEventListener("click", () => hit(false));
  standButton.addEventListener("click", () => {
    if (phase === "play") stand();
  });
  doubleButton.addEventListener("click", double);
  for (const button of betButtons) {
    button.addEventListener("click", () => {
      bet = Number(button.dataset.bet);
      paint();
    });
  }

  host.onSeed((seed) => {
    run++;
    random = rng(seed);
    shuffle();
    bank = START_BANK;
    phase = "idle";
    clearTable();
    say.textContent = "Deal to start.";
    paint();
  });
};

export default toy;
