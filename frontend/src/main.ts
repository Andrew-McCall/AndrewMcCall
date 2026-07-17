import secret_index from "./secret_index.ts";
import secret_morse, { disposeMorse } from "./secret_morse.ts";
import secret_pi, { disposePi } from "./secret_pi.ts";
import { hideGame } from "./secret_canvas.ts";
import home from "./home.ts";
import { postsList, postPage } from "./posts.ts";
import secret_admin_posts from "./secret_admin_posts.ts";
import secret_admin_projects from "./secret_admin_projects.ts";
import secret_admin_profile from "./secret_admin_profile.ts";
import secret_password from "./secret_password.ts";
import secret_countries from "./secret_countries.ts";
import secret_visits, { disposeVisits } from "./secret_visits.ts";
import secret_admin from "./secret_admin.ts";
import secret_admin_visits from "./secret_admin_visits.ts";
import secret_notes from "./secret_notes.ts";
import secret_prettier from "./secret_prettier.ts";
import secret_vim from "./secret_vim.ts";
import secret_time, { disposeTime } from "./secret_time.ts";
import secret_colour from "./secret_colour.ts";
import secret_barcode from "./secret_barcode.ts";
import secret_cron from "./secret_cron.ts";
import secret_python from "./secret_python.ts";
import secret_man from "./secret_man.ts";
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

const routes: Record<string, Route> = {
  "/": { auth: "public", render: (app) => home(app) },
  "/posts": { auth: "public", render: (app) => postsList(app) },
  "/secret": { auth: "public", render: (app) => secret_index(app) },
  "/secret/pi": { auth: "public", render: (app) => secret_pi(app) },
  "/secret/morse": { auth: "public", render: (app) => secret_morse(app) },
  "/secret/password": { auth: "public", render: (app) => secret_password(app) },
  "/secret/countries": { auth: "public", render: (app) => secret_countries(app) },
  "/secret/visits": { auth: "public", render: (app) => secret_visits(app) },
  "/secret/prettier": { auth: "public", render: (app) => secret_prettier(app) },
  "/secret/vim": { auth: "public", render: (app) => secret_vim(app) },
  "/secret/time": { auth: "public", render: (app) => secret_time(app) },
  "/secret/colour": { auth: "public", render: (app) => secret_colour(app) },
  "/secret/barcode": { auth: "public", render: (app) => secret_barcode(app) },
  "/secret/cron": { auth: "public", render: (app) => secret_cron(app) },
  "/secret/man": { auth: "public", render: (app) => secret_man(app) },
  "/secret/python": { auth: "public", render: (app) => secret_python(app) },
  "/secret/notes": { auth: "user", render: (app) => secret_notes(app) },
  "/secret/admin": { auth: "admin", render: (app, me) => secret_admin(app, me!) },
  "/secret/admin/visits": { auth: "admin", render: (app) => secret_admin_visits(app) },
  "/secret/admin/posts": { auth: "admin", render: (app) => secret_admin_posts(app) },
  "/secret/admin/projects": { auth: "admin", render: (app) => secret_admin_projects(app) },
  "/secret/admin/profile": { auth: "admin", render: (app) => secret_admin_profile(app) },
};

// Routes with a path parameter, matched by prefix after the exact table misses.
const prefixRoutes: {
  prefix: string;
  auth: Auth;
  render: (app: HTMLElement, param: string, me: Me | null) => void | Promise<void>;
}[] = [
  { prefix: "/posts/", auth: "public", render: (app, slug) => postPage(app, slug) },
];

async function renderPage(): Promise<void> {
  if (!app) {
    return window.location.reload();
  }

  const page = window.location.pathname.toLowerCase();
  if (page !== "/") {
    hideGame(); // dismiss the fullscreen Game of Life when leaving the front page
  }
  if (page !== "/secret/visits") {
    disposeVisits(); // tear down the ApexCharts when navigating away
  }
  if (page !== "/secret/morse") {
    disposeMorse(); // detach the keyer's window listeners + stop audio/timers
  }
  if (page !== "/secret/pi") {
    disposePi(); // detach the keypad's window keydown listener
  }
  if (page !== "/secret/time") {
    disposeTime(); // stop the relative-time tab's 1s ticker
  }

  app.innerHTML = "";

  if (page === "/secret/login") {
    // Sign-in now lives inside the secret menu; keep the old path working.
    window.history.replaceState({}, "", "/secret");
    return secret_index(app);
  }

  const route = routes[page];
  if (!route) {
    const prefixed = prefixRoutes.find(
      (r) => page.startsWith(r.prefix) && page.length > r.prefix.length,
    );
    if (prefixed) {
      // Only public prefix routes exist today, so no session gate here.
      return prefixed.render(app, page.slice(prefixed.prefix.length), null);
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
