import "./banana.css";
import { $ } from "../dom";
import { pixelHtml } from "../pixels";
import { rng, type Rng, type Toy } from "../toy";

interface ShopItem {
  name: string;
  price: number;
  gives: number;
  every: number;
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
  { name: "Bigger hand", price: 10, gives: 1, every: 0 },
  { name: "Monkey", price: 25, gives: 1, every: 1 },
  { name: "Tree", price: 150, gives: 6, every: 2 },
  { name: "Ladder", price: 500, gives: 4, every: 0 },
  { name: "Plantation", price: 1500, gives: 50, every: 4 },
  { name: "Crane", price: 5000, gives: 30, every: 0 },
  { name: "Cargo ship", price: 12000, gives: 400, every: 5 },
  { name: "Ripening lab", price: 90000, gives: 4000, every: 8 },
  { name: "Moon farm", price: 750000, gives: 30000, every: 10 },
];

const GOLD_MULTIPLIER = 5;
const GOLD_SECONDS = 6;
const TICK_SECONDS = 0.1;
const FLOAT_MS = 800;

const MARKUP = `
  <div class="toy-bar">
    <button class="btn" type="button" data-restart>Restart</button>
    <span class="tag" id="nana-rate"></span>
  </div>
  <div class="nana">
    <button class="nana-btn field" id="nana" type="button" aria-label="Pick a banana">
      <span class="px"></span>
    </button>
    <div class="nana-side">
      <p class="lede" id="nana-count" aria-live="off">0 bananas</p>
      <div class="shop" id="nana-shop"></div>
      <p class="tag nana-more" id="nana-more"></p>
    </div>
  </div>`;

const format = (amount: number): string => Math.floor(amount).toLocaleString("en-GB");

const compact = new Intl.NumberFormat("en-GB", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const short = (amount: number): string => compact.format(Math.floor(amount));

const gain = (item: ShopItem, amount: number): string =>
  item.every ? `+${short(amount)} every ${item.every}s` : `+${short(amount)} a click`;

export const reach = (owned: number[], affordable: boolean[]): number => {
  const next = owned.findIndex((count, index) => count === 0 && !affordable[index]);
  return next === -1 ? owned.length : next + 1;
};

const toy: Toy = (host) => {
  host.body.innerHTML = MARKUP;
  const banana = $<HTMLButtonElement>("#nana", host.body);
  const shop = $("#nana-shop", host.body);
  const count = $("#nana-count", host.body);
  const rate = $("#nana-rate", host.body);
  const more = $("#nana-more", host.body);
  $(".px", banana).innerHTML = pixelHtml(ART);
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  let random: Rng = Math.random;
  let bananas = 0;
  let owned = SHOP.map(() => 0);
  let made = SHOP.map(() => 0);
  let wait = SHOP.map(() => 0);
  let seen = 0;
  let elapsed = 0;
  let goldLeft = 0;
  let goldDue = 0;

  const cost = (index: number): number =>
    Math.ceil(SHOP[index].price * 1.15 ** owned[index]);

  const perClick = (): number =>
    SHOP.reduce((sum, item, index) => (item.every ? sum : sum + item.gives * owned[index]), 1);

  const perSecond = (): number =>
    SHOP.reduce(
      (sum, item, index) => (item.every ? sum + (item.gives * owned[index]) / item.every : sum),
      0,
    );

  const buy = (index: number): void => {
    if (bananas < cost(index)) return;
    bananas -= cost(index);
    owned[index]++;
    paint();
  };

  const rows = SHOP.map((_, index) => {
    const row = document.createElement("div");
    row.className = "nana-item";
    row.innerHTML = `<button class="btn" type="button"><span></span><span></span></button><span class="nana-stat"></span>`;
    const button = $<HTMLButtonElement>("button", row);
    button.addEventListener("click", () => buy(index));
    shop.append(row);
    const [name, price] = button.children as HTMLCollectionOf<HTMLElement>;
    return { row, button, name, price, stat: $(".nana-stat", row) };
  });

  function paint(): void {
    const plural = Math.floor(bananas) === 1 ? "" : "s";
    const golden = goldLeft > 0 ? ` · golden ×${GOLD_MULTIPLIER} ${Math.ceil(goldLeft)}s` : "";
    count.textContent = `${format(bananas)} banana${plural}`;
    rate.textContent =
      `${format(perClick())} a click · ${format(perSecond())} a second${golden}`;
    seen = Math.max(seen, reach(owned, SHOP.map((_, index) => bananas >= cost(index))));
    rows.forEach((row, index) => {
      const item = SHOP[index];
      row.row.hidden = index >= seen;
      row.name.textContent = `${item.name} ×${owned[index]}`;
      row.price.textContent = short(cost(index));
      row.button.disabled = bananas < cost(index);
      row.stat.textContent = owned[index]
        ? `${gain(item, item.gives * owned[index])} · ${short(made[index])} made`
        : `${gain(item, item.gives)} each`;
      const ticking = item.every > 0 && owned[index] > 0;
      row.stat.classList.toggle("ticking", ticking);
      row.stat.style.setProperty("--p", ticking ? `${(wait[index] / item.every) * 100}%` : "0%");
    });
    const hidden = SHOP.length - seen;
    more.textContent = hidden ? `${hidden} more to find…` : "";
  }

  function grow(): void {
    elapsed += TICK_SECONDS;
    SHOP.forEach((item, index) => {
      if (!item.every || !owned[index]) return;
      wait[index] += TICK_SECONDS;
      while (wait[index] >= item.every) {
        wait[index] -= item.every;
        bananas += item.gives * owned[index];
        made[index] += item.gives * owned[index];
      }
    });
    if (goldLeft > 0) {
      goldLeft -= TICK_SECONDS;
      if (goldLeft <= 0) {
        banana.classList.remove("gold");
        goldDue = elapsed + 20 + random() * 40;
      }
    } else if (elapsed >= goldDue) {
      goldLeft = GOLD_SECONDS;
      banana.classList.add("gold");
    }
    if (host.visible()) paint();
  }

  const float = (event: MouseEvent, amount: number): void => {
    if (still.matches) return;
    const box = banana.getBoundingClientRect();
    const keyed = event.detail === 0;
    const pop = document.createElement("span");
    pop.className = "nana-pop";
    pop.textContent = `+${short(amount)}`;
    pop.style.left = `${keyed ? box.width / 2 : event.clientX - box.left}px`;
    pop.style.top = `${keyed ? box.height / 2 : event.clientY - box.top}px`;
    banana.append(pop);
    host.later(FLOAT_MS, () => pop.remove());
  };

  banana.addEventListener("click", (event) => {
    const multiplier = goldLeft > 0 ? GOLD_MULTIPLIER : 1;
    SHOP.forEach((item, index) => {
      if (!item.every) made[index] += item.gives * owned[index] * multiplier;
    });
    const amount = perClick() * multiplier;
    bananas += amount;
    float(event, amount);
    paint();
  });
  host.every(TICK_SECONDS * 1000, grow);
  host.onSeed((seed) => {
    random = rng(seed);
    bananas = 0;
    owned = SHOP.map(() => 0);
    made = SHOP.map(() => 0);
    wait = SHOP.map(() => 0);
    seen = 0;
    elapsed = 0;
    goldLeft = 0;
    goldDue = 8 + random() * 30;
    banana.classList.remove("gold");
    paint();
  });
};

export default toy;
