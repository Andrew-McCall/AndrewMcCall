import { mountLogin } from "./secret_login.ts";

type MenuItem = { href: string; label: string; disabled?: boolean };
type MenuGroup = { title: string; items: MenuItem[] };

const groups: MenuGroup[] = [
  {
    title: "Developer Tools",
    items: [
      { href: "/secret/vim", label: "Vim" },
      { href: "/secret/cron", label: "Cron Generator" },
      { href: "/secret/man", label: "Man Pages" },
      { href: "/secret/python", label: "Python 3" },
      { href: "/secret/prettier", label: "Prettier" },
    ],
  },
  {
    title: "Generators & Utilities",
    items: [
      { href: "/secret/password", label: "Password Generator" },
      { href: "/secret/colour", label: "Colour Picker" },
      { href: "/secret/barcode", label: "Barcodes" },
      { href: "/secret/time", label: "Time" },
      { href: "/secret/notes", label: "Notes" },
    ],
  },
  {
    title: "Games & Curiosities",
    items: [
      { href: "/secret/countries", label: "Countries Quiz" },
      { href: "/secret/pi", label: "PI Tester" },
      { href: "/secret/morse", label: "Morse Code" },
      { href: "/secret/canvas", label: "Rust Canvas" },
    ],
  },
  {
    title: "Site",
    items: [
      { href: "/secret/visits", label: "Visits" },
      { href: "/secret/soon", label: "coming soon", disabled: true },
    ],
  },
];

const renderItem = (item: MenuItem) =>
  item.disabled
    ? `<span class="block bg-stone-900 border border-green-900/60 rounded-lg px-4 py-3 text-center text-lime-700 italic line-through">${item.label}</span>`
    : `<a href="${item.href}" class="block bg-stone-900 border border-green-900 hover:border-green-600 rounded-lg px-4 py-3 text-center text-lime-400 hover:text-lime-200 transition-colors">${item.label}</a>`;

const renderGroup = (group: MenuGroup) => `
  <div class="w-full">
    <h2 class="text-green-700 uppercase tracking-widest text-sm font-bold mb-3 text-left">${group.title}</h2>
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
      ${group.items.map(renderItem).join("\n")}
    </div>
  </div>
`;

export default (app: HTMLElement) => {
  app.innerHTML += `
<div class="flex flex-col justify-center items-center py-2">
  <a href="/">
    <h1 title="Well Done" class="hover:underline italic text-7xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Secret Menu
    </h1>
  </a>
  <div class="w-full max-w-2xl flex flex-col gap-8 mt-8">
    ${groups.map(renderGroup).join("\n")}
  </div>

  <div class="w-full border-t border-green-900/60 mt-8 pt-6"></div>
  <div id="secret-auth" class="w-full"></div>
</div>
`;

  mountLogin(app.querySelector<HTMLDivElement>("#secret-auth")!);
};
