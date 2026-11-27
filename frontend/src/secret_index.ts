import { mountLogin } from "./secret_login.ts";
import { getMe } from "./session.ts";
import { isDesktop } from "./mobile.ts";

// `auth` items are hidden until the visitor is signed in.
type MenuItem = {
  href: string;
  label: string;
  disabled?: boolean;
  auth?: boolean;
  desktop?: boolean;
};
type MenuGroup = { title: string; glyph: string; colour: string; items: MenuItem[] };

const groups: MenuGroup[] = [
  {
    title: "Developer Tools",
    colour: "term",
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
    colour: "projects",
    glyph: "#",
    items: [
      { href: "/secret/password", label: "Password Generator" },
      { href: "/secret/colour", label: "Colour Picker" },
      { href: "/secret/barcode", label: "Barcodes" },
      { href: "/secret/pixels", label: "Pixel Shapes" },
      { href: "/secret/time", label: "Time" },
      { href: "/secret/notes", label: "Notes", auth: true },
      { href: "/secret/ukrainian", label: "Ukrainian", auth: true },
    ],
  },
  {
    title: "Games & Curiosities",
    colour: "now",
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
    colour: "posts",
    glyph: "~",
    items: [
      { href: "/secret/visits", label: "Visits" },
      { href: "/secret/live", label: "Live", auth: true },
      { href: "/secret/account", label: "Account", auth: true },
      { href: "/secret/soon", label: "coming soon", disabled: true },
    ],
  },
];

const renderItem = (item: MenuItem, animate: boolean) =>
  item.disabled
    ? `<span class="panel-item" aria-disabled="true">${item.label}</span>`
    : `<a href="${item.href}" class="panel-item${animate ? " secret-rise" : ""}">${item.label}</a>`;

const renderGroup = (group: MenuGroup, signedIn: boolean, justSignedIn: boolean) => {
  const onDesktop = isDesktop();
  const items = group.items
    .filter((item) => !item.auth || signedIn)
    .filter((item) => !item.desktop || onDesktop);
  if (items.length === 0) return "";
  return `
  <section class="panel" style="--w: var(--w-${group.colour})">
    <h2 class="panel-bar"><span>${group.glyph}</span>${group.title}</h2>
    <div class="panel-grid">
      ${items.map((item) => renderItem(item, justSignedIn && !!item.auth)).join("\n")}
    </div>
  </section>
`;
};

const secretIndex = async (app: HTMLElement) => {
  let me = await getMe();
  app.innerHTML += `
<div class="flex flex-col items-center py-2 px-4">
  <div class="w-full max-w-3xl flex justify-end mb-2 min-h-8">
    <div id="secret-auth" class="relative"></div>
  </div>
  <a href="/">
    <h1 title="Well Done" class="hover:underline page-title text-center">
      Secret Menu
    </h1>
  </a>
  <div id="secret-groups" class="w-full max-w-3xl flex flex-col gap-2 mt-8"></div>
</div>
`;

  const authSlot = app.querySelector<HTMLDivElement>("#secret-auth")!;
  const groupsSlot = app.querySelector<HTMLDivElement>("#secret-groups")!;

  const renderGroups = (signedIn: boolean, justSignedIn: boolean) => {
    groupsSlot.innerHTML = groups
      .map((g) => renderGroup(g, signedIn, justSignedIn))
      .join("\n");
  };

  // Mount the header identity widget, re-rendering only the grid + widget on
  // sign-in/out (no full-page wipe, so the title/header don't flash). Gated
  // tiles fade in the first render after a fresh sign-in.
  const mountAuth = () => {
    void mountLogin(authSlot, me, async () => {
      const wasSignedIn = me !== null;
      me = await getMe();
      renderGroups(me !== null, !wasSignedIn && me !== null);
      mountAuth();
    });
  };

  renderGroups(me !== null, false);
  mountAuth();
};

export default secretIndex;
