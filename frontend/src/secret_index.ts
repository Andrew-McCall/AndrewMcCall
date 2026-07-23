import { mountLogin } from "./secret_login.ts";
import { getMe } from "./session.ts";

// `auth` items are hidden until the visitor is signed in.
type MenuItem = {
  href: string;
  label: string;
  disabled?: boolean;
  auth?: boolean;
  desktop?: boolean;
};
type MenuGroup = { title: string; glyph: string; items: MenuItem[] };

const groups: MenuGroup[] = [
  {
    title: "Developer Tools",
    glyph: ">_",
    items: [
      { href: "/secret/vim", label: "Vim", desktop: true },
      { href: "/secret/cron", label: "Cron Generator" },
      { href: "/secret/man", label: "Man Pages" },
      { href: "/secret/python", label: "Python 3" },
      { href: "/secret/prettier", label: "Prettier" },
    ],
  },
  {
    title: "Generators & Utilities",
    glyph: "#",
    items: [
      { href: "/secret/password", label: "Password Generator" },
      { href: "/secret/colour", label: "Colour Picker" },
      { href: "/secret/barcode", label: "Barcodes" },
      { href: "/secret/time", label: "Time" },
      { href: "/secret/notes", label: "Notes", auth: true },
    ],
  },
  {
    title: "Games & Curiosities",
    glyph: "?",
    items: [
      { href: "/secret/countries", label: "Countries Quiz" },
      { href: "/secret/pi", label: "PI Tester" },
      { href: "/secret/morse", label: "Morse Code" },
      { href: "/secret/languages", label: "100 Languages" },
    ],
  },
  {
    title: "Site",
    glyph: "~",
    items: [
      { href: "/secret/visits", label: "Visits" },
      { href: "/secret/soon", label: "coming soon", disabled: true },
    ],
  },
];

const renderItem = (item: MenuItem) =>
  item.disabled
    ? `<span class="flex items-center justify-center h-full bg-stone-950/60 border border-green-900/30 px-4 py-3 text-center text-green-900 italic line-through select-none">${item.label}</span>`
    : `<a href="${item.href}" class="flex items-center justify-center h-full bg-stone-900 border border-green-900 px-4 py-3 text-center text-lime-400
        transition-all duration-150 ease-out
        hover:border-green-500 hover:text-lime-200 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-2px_rgba(34,197,94,0.25)]
        active:translate-y-0 active:shadow-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">${item.label}</a>`;

const renderGroup = (group: MenuGroup, signedIn: boolean) => {
  const isOnDesktop =
    window.matchMedia("(any-hover: hover)").matches &&
    window.matchMedia("(any-pointer: fine)").matches &&
    !("ontouchstart" in window && navigator.maxTouchPoints > 0);
  const items = group.items
    .filter((item) => !item.auth || signedIn)
    .filter((item) => !item.desktop || isOnDesktop);
  if (items.length === 0) return "";
  return `
  <div class="w-full bg-stone-950/40 border border-green-900/30 p-4 sm:p-5">
    <h2 class="flex items-center gap-2 text-green-600 uppercase tracking-widest text-sm font-bold mb-4 text-left">
      <span class="inline-flex items-center justify-center w-6 h-6 bg-green-950 border border-green-900 text-xs normal-case tracking-normal text-green-500">${group.glyph}</span>
      ${group.title}
    </h2>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      ${items.map(renderItem).join("\n")}
    </div>
  </div>
`;
};

const secretIndex = async (app: HTMLElement) => {
  const me = await getMe();
  app.innerHTML += `
<div class="flex flex-col justify-center items-center py-2">
  <a href="/">
    <h1 title="Well Done" class="hover:underline italic text-7xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Secret Menu
    </h1>
  </a>
  <div class="w-full max-w-3xl flex flex-col gap-6 mt-8">
    ${groups.map((g) => renderGroup(g, me !== null)).join("\n")}
  </div>

  <div class="w-full border-t border-green-900/60 mt-8 pt-6"></div>
  <div id="secret-auth" class="w-full"></div>
</div>
`;

  // Re-render on sign-in/out so gated menu items appear or disappear.
  mountLogin(app.querySelector<HTMLDivElement>("#secret-auth")!, me, () => {
    app.innerHTML = "";
    void secretIndex(app);
  });
};

export default secretIndex;
