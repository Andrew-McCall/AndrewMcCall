import { mountLogin } from "./secret_login.ts";

// The secret menu. Tools are grouped into themed cards rather than one long
// list — each group is a bordered card, each tool an outlined link that lights
// up on hover. Adding a tool is a one-line edit to the relevant group below.

type Item = { label: string; href: string; soon?: boolean };
type Group = { title: string; items: Item[] };

const GROUPS: Group[] = [
  {
    title: "Generators",
    items: [
      { label: "Password Generator", href: "/secret/password" },
      { label: "Barcodes", href: "/secret/barcode" },
      { label: "Cron Generator", href: "/secret/cron" },
      { label: "Colour Picker", href: "/secret/colour" },
    ],
  },
  {
    title: "Dev Tools",
    items: [
      { label: "Prettier", href: "/secret/prettier" },
      { label: "Vim", href: "/secret/vim" },
      { label: "Python 3", href: "/secret/python" },
      { label: "Man Pages", href: "/secret/man" },
      { label: "Time", href: "/secret/time" },
    ],
  },
  {
    title: "Games & Toys",
    items: [
      { label: "PI Tester", href: "/secret/pi" },
      { label: "Morse Code", href: "/secret/morse" },
      { label: "Rust Canvas", href: "/secret/canvas" },
      { label: "Countries Quiz", href: "/secret/countries" },
      { label: "coming soon", href: "", soon: true },
    ],
  },
  {
    title: "Your Data",
    items: [
      { label: "Visits", href: "/secret/visits" },
      { label: "Notes", href: "/secret/notes" },
    ],
  },
];

const itemHtml = (item: Item): string => {
  if (item.soon) {
    return `<span class="flex items-center justify-between border border-green-900/40 rounded px-3 py-2 text-green-800 italic line-through cursor-not-allowed select-none">
      ${item.label}
    </span>`;
  }
  return `<a href="${item.href}"
    class="group flex items-center justify-between border border-green-900/60 hover:border-green-600 hover:bg-green-900/20 rounded px-3 py-2 text-green-400 hover:text-green-200 transition-colors">
    <span>${item.label}</span>
    <span class="text-green-800 group-hover:text-green-500 transition-colors">&rarr;</span>
  </a>`;
};

const groupHtml = (group: Group): string => `
<section class="bg-stone-900/40 border border-green-900/60 rounded-lg p-4 flex flex-col gap-3">
  <h2 class="text-green-700 font-mono text-xs uppercase tracking-widest">${group.title}</h2>
  <div class="flex flex-col gap-2 font-mono">
    ${group.items.map(itemHtml).join("")}
  </div>
</section>`;

export default (app: HTMLElement) => {
  app.innerHTML += `
<div class="flex flex-col items-center min-h-screen py-10 px-4">
  <a href="/">
    <h1 title="Well Done" class="hover:underline italic text-6xl md:text-7xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Secret Menu
    </h1>
  </a>
  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    A pile of little browser tools — pick one.
  </p>

  <div class="w-full max-w-4xl mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
    ${GROUPS.map(groupHtml).join("")}
  </div>

  <div class="w-full max-w-4xl border-t border-green-900/60 mt-10 pt-6"></div>
  <div id="secret-auth" class="w-full"></div>
</div>
`;

  mountLogin(app.querySelector<HTMLDivElement>("#secret-auth")!);
};
