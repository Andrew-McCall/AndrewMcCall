// The front page and its Game-of-Life canvas are the critical path, so they stay
// in the entry chunk. Every other page is pulled in on demand via dynamic
// `import()` below — Vite splits each into its own chunk, so a visitor who only
// ever sees `/` no longer downloads the admin screens and secret tools.
import home from "./home.ts";
import { hideGame } from "./secret_canvas.ts";
import { getMe, type Me } from "./session.ts";

window.addEventListener("popstate", () => {
  renderPage();
});

var app = document.querySelector<HTMLDivElement>("#app");

// What a route asks of the visitor. `admin` implies signed in; `user` is any
// signed-in account (for the per-user pages); `public` is open to everyone.
// Gating lives here in the router so no page re-implements the `/auth/me`
// bounce — the resolved user is handed to the page instead.
type Auth = "public" | "user" | "admin";

// A page renderer. `me` is the signed-in user for gated routes, `null` on public
// ones; public pages simply ignore it.
type Handler = (app: HTMLElement, me: Me | null) => void | Promise<void>;

interface Route {
  auth: Auth;
  render: Handler;
}

// Lazily-loaded modules, kept so navigation teardown can reach a page's disposer
// without force-loading a chunk the visitor never opened. Keyed by a short name.
const loaded = new Map<string, any>();

// Most pages export a default renderer taking just the app element. Wrapping the
// dynamic import here keeps each page in its own chunk while staying terse.
const lazy =
  (loader: () => Promise<{ default: (app: HTMLElement) => unknown }>): Handler =>
  (app) =>
    loader().then((m) => {
      m.default(app);
    });

// A lazy page that also owns a disposer the router calls on the way out. The
// resolved module is stashed in `loaded` under `name` so teardown can find it.
const disposable =
  (
    name: string,
    loader: () => Promise<{ default: (app: HTMLElement) => unknown }>,
  ): Handler =>
  (app) =>
    loader().then((m) => {
      loaded.set(name, m);
      m.default(app);
    });

const routes: Record<string, Route> = {
  "/": { auth: "public", render: (app) => home(app) },
  "/posts": {
    auth: "public",
    render: (app) => import("./posts.ts").then((m) => m.postsList(app)),
  },
  "/secret": { auth: "public", render: lazy(() => import("./secret_index.ts")) },
  "/secret/pi": {
    auth: "public",
    render: disposable("pi", () => import("./secret_pi.ts")),
  },
  "/secret/morse": {
    auth: "public",
    render: disposable("morse", () => import("./secret_morse.ts")),
  },
  "/secret/password": {
    auth: "public",
    render: lazy(() => import("./secret_password.ts")),
  },
  "/secret/countries": {
    auth: "public",
    render: lazy(() => import("./secret_countries.ts")),
  },
  "/secret/visits": {
    auth: "public",
    render: disposable("visits", () => import("./secret_visits.ts")),
  },
  "/secret/prettier": {
    auth: "public",
    render: lazy(() => import("./secret_prettier.ts")),
  },
  "/secret/vim": {
    auth: "public",
    render: disposable("vim", () => import("./secret_vim.ts")),
  },
  "/secret/time": {
    auth: "public",
    render: disposable("time", () => import("./secret_time.ts")),
  },
  "/secret/colour": {
    auth: "public",
    render: lazy(() => import("./secret_colour.ts")),
  },
  "/secret/barcode": {
    auth: "public",
    render: lazy(() => import("./secret_barcode.ts")),
  },
  "/secret/pixels": {
    auth: "public",
    render: lazy(() => import("./secret_pixels.ts")),
  },
  "/secret/cron": { auth: "public", render: lazy(() => import("./secret_cron.ts")) },
  "/secret/man": { auth: "public", render: lazy(() => import("./secret_man.ts")) },
  "/secret/languages": {
    auth: "public",
    render: lazy(() => import("./secret_languages.ts")),
  },
  "/secret/python": {
    auth: "public",
    render: lazy(() => import("./secret_python.ts")),
  },
  "/secret/notes": {
    auth: "user",
    render: disposable("notes", () => import("./secret_notes.ts")),
  },
  "/secret/account": {
    auth: "user",
    render: (app, me) =>
      import("./secret_account.ts").then((m) => m.default(app, me!)),
  },
  "/secret/admin": {
    auth: "admin",
    render: (app, me) =>
      import("./secret_admin.ts").then((m) => m.default(app, me!)),
  },
  "/secret/admin/visits": {
    auth: "admin",
    render: lazy(() => import("./secret_admin_visits.ts")),
  },
  "/secret/admin/posts": {
    auth: "admin",
    render: lazy(() => import("./secret_admin_posts.ts")),
  },
  "/secret/admin/projects": {
    auth: "admin",
    render: lazy(() => import("./secret_admin_projects.ts")),
  },
  "/secret/admin/profile": {
    auth: "admin",
    render: lazy(() => import("./secret_admin_profile.ts")),
  },
  "/secret/admin/details": {
    auth: "admin",
    render: lazy(() => import("./secret_admin_details.ts")),
  },
};

// Routes with a path parameter, matched by prefix after the exact table misses.
const prefixRoutes: {
  prefix: string;
  auth: Auth;
  name?: string; // stashed in `loaded` when the page owns a disposer
  render: (app: HTMLElement, param: string, me: Me | null) => void | Promise<void>;
}[] = [
  {
    prefix: "/posts/",
    auth: "public",
    render: (app, slug) => import("./posts.ts").then((m) => m.postPage(app, slug)),
  },
  {
    prefix: "/secret/notes/",
    auth: "user",
    name: "notes",
    render: (app, slug) =>
      import("./secret_notes.ts").then((m) => {
        loaded.set("notes", m);
        return m.default(app, decodeURIComponent(slug));
      }),
  },
];

async function renderPage(): Promise<void> {
  if (!app) {
    return window.location.reload();
  }

  const page = window.location.pathname.toLowerCase();
  if (page !== "/") {
    hideGame(); // dismiss the fullscreen Game of Life when leaving the front page
  }
  // Teardown only touches pages that were actually loaded — `loaded.get` misses
  // for a chunk the visitor never opened, so this never force-loads anything.
  if (page !== "/secret/visits") {
    loaded.get("visits")?.disposeVisits(); // tear down the ApexCharts
  }
  if (page !== "/secret/morse") {
    loaded.get("morse")?.disposeMorse(); // detach keyer listeners + stop audio
  }
  if (page !== "/secret/pi") {
    loaded.get("pi")?.disposePi(); // detach the keypad's window keydown listener
  }
  if (page !== "/secret/time") {
    loaded.get("time")?.disposeTime(); // stop the relative-time tab's 1s ticker
  }
  if (page !== "/secret/vim") {
    // Tear down an open game: its keydown handler preventDefaults keys the rest
    // of the site needs (Snake takes h/j/k/l and space).
    loaded.get("vim")?.disposeVim();
  }
  // The notes page owns keyboard/connectivity listeners and a pending autosave,
  // so it is only torn down when leaving the section entirely — navigating
  // between two notes re-enters the same page.
  if (!page.startsWith("/secret/notes")) {
    loaded.get("notes")?.disposeNotes();
  }

  app.innerHTML = "";

  if (page === "/secret/login") {
    // Sign-in now lives inside the secret menu; keep the old path working.
    window.history.replaceState({}, "", "/secret");
    return void import("./secret_index.ts").then((m) => m.default(app!));
  }

  const route = routes[page];
  if (!route) {
    const prefixed = prefixRoutes.find(
      (r) => page.startsWith(r.prefix) && page.length > r.prefix.length,
    );
    if (prefixed) {
      // Same gate as the exact table: resolve the session for protected
      // prefixes and bounce anyone who isn't allowed.
      let me: Me | null = null;
      if (prefixed.auth !== "public") {
        me = await getMe();
        if (!me || (prefixed.auth === "admin" && me.role !== "admin")) {
          return window.navigate("/secret");
        }
        if (window.location.pathname.toLowerCase() !== page) return;
      }
      return prefixed.render(app, page.slice(prefixed.prefix.length), me);
    }
    // 404 — send them home and render it.
    window.history.pushState({}, "", "/");
    return home(app);
  }

  // Middleware gate: resolve the session for protected routes and bounce anyone
  // who isn't allowed to the secret menu (which hosts sign-in).
  let me: Me | null = null;
  if (route.auth !== "public") {
    me = await getMe();
    if (!me || (route.auth === "admin" && me.role !== "admin")) {
      return window.navigate("/secret");
    }
    // A newer navigation may have started while `/auth/me` was in flight; if so,
    // let that one win rather than rendering this now-stale page over it.
    if (window.location.pathname.toLowerCase() !== page) {
      return;
    }
  }

  return route.render(app, me);
}


function navigateImpl(new_url: string): void {
  const url = String(new_url);
  // Navigating to the page you're already on is a no-op: don't push a duplicate
  // history entry and don't wipe + rebuild the DOM that's already correct.
  const target = new URL(url, window.location.origin);
  if (
    target.pathname === window.location.pathname &&
    target.search === window.location.search
  ) {
    return;
  }
  window.history.pushState({}, '', url);
  renderPage();
}

declare global {
  interface Window {
    navigate: (new_url: string) => void;
  }
}

window.navigate = navigateImpl;
(globalThis as any).navigate = navigateImpl;


renderPage();

// Ping once, when the app boots, to record that a real JavaScript-capable
// client loaded the page. nginx already logs the per-route hits; this only
// distinguishes a live browser from a bare asset fetch or a bot. Fire-and-forget
// — a failed visit log must never surface to the visitor or block anything.
fetch("/api/log/js", { method: "POST", keepalive: true }).catch(() => {});
