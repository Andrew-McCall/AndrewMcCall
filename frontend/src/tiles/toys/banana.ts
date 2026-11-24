import "./banana.css";
import { $ } from "../dom";
import { rng, type Rng, type Toy } from "../toy";

interface ShopItem {
  name: string;
  price: number;
  perClick: number;
  perSecond: number;
}

const ART = [
  "..........##",
  ".........##.",
  "........###.",
  ".......####.",
  "......#####.",
  ".....#####..",
  "....######..",
  "..#######...",
  ".#######....",
  "#######.....",
  ".#####......",
  "............",
];

const SHOP: ShopItem[] = [
  { name: "Bigger hand", price: 10, perClick: 1, perSecond: 0 },
  { name: "Monkey", price: 25, perClick: 0, perSecond: 1 },
  { name: "Tree", price: 150, perClick: 0, perSecond: 5 },
  { name: "Plantation", price: 1000, perClick: 0, perSecond: 25 },
];

const GOLD_MULTIPLIER = 5;
const TICK_SECONDS = 0.25;

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <span class="tag" id="nana-rate"></span>
  </div>
  <div class="nana">
    <button class="nana-btn" id="nana" type="button" aria-label="Pick a banana">
      <span class="px"></span>
    </button>
    <div class="nana-side">
      <p class="lede" id="nana-count" aria-live="off">0 bananas</p>
      <div class="shop" id="nana-shop"></div>
    </div>
  </div>`;

const format = (amount: number): string => Math.floor(amount).toLocaleString("en-GB");

const pixels = (rows: string[]): string =>
  rows
    .join("")
    .replace(/./g, (cell) => `<i${cell === "#" ? ' class="on"' : ""}></i>`);

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const banana = $<HTMLButtonElement>("#nana", host.body);
  const shop = $("#nana-shop", host.body);
  const count = $("#nana-count", host.body);
  const rate = $("#nana-rate", host.body);
  $(".px", banana).innerHTML = pixels(ART);

  let random: Rng = Math.random;
  let bananas = 0;
  let owned = SHOP.map(() => 0);
  let elapsed = 0;
  let goldLeft = 0;
  let goldDue = 0;

  const cost = (index: number): number =>
    Math.ceil(SHOP[index].price * 1.15 ** owned[index]);

  const perClick = (): number =>
    SHOP.reduce((sum, item, index) => sum + item.perClick * owned[index], 1);

  const perSecond = (): number =>
    SHOP.reduce((sum, item, index) => sum + item.perSecond * owned[index], 0);

  const buy = (index: number): void => {
    if (bananas < cost(index)) return;
    bananas -= cost(index);
    owned[index]++;
    paint();
  };

  const buttons = SHOP.map((_, index) => {
    const button = document.createElement("button");
    button.className = "btn";
    button.type = "button";
    button.addEventListener("click", () => buy(index));
    shop.append(button);
    return button;
  });

  function paint(): void {
    const plural = Math.floor(bananas) === 1 ? "" : "s";
    const golden = goldLeft > 0 ? " · golden ×5" : "";
    count.textContent = `${format(bananas)} banana${plural}`;
    rate.textContent =
      `${format(perClick())} a click · ${format(perSecond())} a second${golden}`;
    buttons.forEach((button, index) => {
      const price = document.createElement("span");
      price.textContent = format(cost(index));
      button.replaceChildren(`${SHOP[index].name} ×${owned[index]}`, price);
      button.disabled = bananas < cost(index);
    });
  }

  function grow(): void {
    elapsed += TICK_SECONDS;
    bananas += perSecond() * TICK_SECONDS;
    if (goldLeft > 0) {
      goldLeft -= TICK_SECONDS;
      if (goldLeft <= 0) {
        banana.classList.remove("gold");
        goldDue = elapsed + 20 + random() * 40;
      }
    } else if (elapsed >= goldDue) {
      goldLeft = 6;
      banana.classList.add("gold");
    }
    if (host.visible()) paint();
  }

  banana.addEventListener("click", () => {
    bananas += perClick() * (goldLeft > 0 ? GOLD_MULTIPLIER : 1);
    paint();
  });
  host.every(TICK_SECONDS * 1000, grow);
  host.onSeed((seed) => {
    random = rng(seed);
    bananas = 0;
    owned = SHOP.map(() => 0);
    elapsed = 0;
    goldLeft = 0;
    goldDue = 8 + random() * 30;
    banana.classList.remove("gold");
    paint();
  });
};

export default toy;
