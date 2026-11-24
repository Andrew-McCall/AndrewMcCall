import type { Toy } from "./toy";

export interface WinDef {
  app: string;
  key: string;
  title: string;
  label: string;
  toy?: () => Promise<{ default: Toy }>;
}

export const WINDOWS: WinDef[] = [
  { app: "about", key: "a", title: "~/about", label: "About" },
  { app: "projects", key: "p", title: "~/projects", label: "Projects" },
  { app: "term", key: "t", title: "~/terminal", label: "Terminal" },
  { app: "fetch", key: "f", title: "$ fetch", label: "Stack" },
  { app: "posts", key: "w", title: "~/posts", label: "Writing" },
  { app: "now", key: "n", title: "~/now", label: "Now" },
  { app: "contact", key: "c", title: "~/contact", label: "Contact" },
  {
    app: "asteroids",
    key: "r",
    title: "$ asteroids",
    label: "Asteroids",
    toy: () => import("./toys/asteroids"),
  },
  {
    app: "noughts",
    key: "x",
    title: "$ noughts",
    label: "Noughts and crosses",
    toy: () => import("./toys/noughts"),
  },
  { app: "golf", key: "o", title: "$ golf", label: "Mini golf", toy: () => import("./toys/golf") },
  {
    app: "rps",
    key: "s",
    title: "$ rps",
    label: "Rock paper scissors",
    toy: () => import("./toys/rps"),
  },
  {
    app: "banana",
    key: "b",
    title: "$ banana",
    label: "Banana clicker",
    toy: () => import("./toys/banana"),
  },
  { app: "mines", key: "d", title: "$ mines", label: "Mines", toy: () => import("./toys/mines") },
  {
    app: "paddles",
    key: "e",
    title: "$ paddles",
    label: "Paddles",
    toy: () => import("./toys/paddles"),
  },
  {
    app: "pattern",
    key: "v",
    title: "$ pattern",
    label: "Pattern",
    toy: () => import("./toys/pattern"),
  },
  {
    app: "blackjack",
    key: "z",
    title: "$ blackjack",
    label: "Blackjack",
    toy: () => import("./toys/blackjack"),
  },
  { app: "life", key: "g", title: "$ life", label: "Game of Life", toy: () => import("./toys/life") },
];

export const START_OPEN = ["about", "projects", "term"];
