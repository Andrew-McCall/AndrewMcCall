// Shared page helpers (previously duplicated across the secret_* pages).

export const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

// Is the backend up? `GET /api/health` answers 200 "OK" from a route with no
// database or config dependencies, so a failure here means the process itself
// is unreachable. The result is cached for the page's lifetime: everything that
// gates on it wants one answer, not a probe per caller. Never rejects — a dead
// backend resolves false.
let health: Promise<boolean> | null = null;
export const backendHealthy = (): Promise<boolean> =>
  (health ??= api("/health")
    .then(async (res) => res.ok && (await res.text()).trim() === "OK")
    .catch(() => false));

export const jsonInit = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Reads `{ error }` from a non-2xx JSON body, falling back to the status.
export const errorText = async (res: Response): Promise<string> => {
  const body = await res.json().catch(() => null);
  if (body && typeof body.error === "string") return body.error;
  return `Error ${res.status}`;
};

export const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString() : "—";

// Rough read time in whole minutes (>=1) from a word count at 200 wpm.
export const readingTime = (text: string): number => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
};

// Updates the document title and description/Open-Graph tags for the current
// page, creating the meta elements on first use. Full-reload navigation resets
// the head from index.html, so pages only ever need to set, never restore.
export const setMeta = (title: string, description: string): void => {
  document.title = title;
  const tag = (selector: string, attr: string, val: string) => {
    let el = document.head.querySelector<HTMLMetaElement>(selector);
    if (!el) {
      el = document.createElement("meta");
      const [name, value] = attr.split("=");
      el.setAttribute(name, value);
      document.head.appendChild(el);
    }
    el.setAttribute("content", val);
  };
  tag('meta[name="description"]', "name=description", description);
  tag('meta[property="og:title"]', "property=og:title", title);
  tag('meta[property="og:description"]', "property=og:description", description);
};

// Escapes text for safe interpolation into innerHTML.
export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

// The centred full-page wrapper every standalone view opens with.
export const PAGE_CLASS =
  "flex flex-col items-center min-h-screen py-10 px-4 text-green-500";

// The big centred gradient title the standalone tool pages open with, linked
// back to wherever the page came from.
//
// Deliberately covers only this one shape. The admin and list headers use a
// smaller left-aligned title in a row beside other controls, at three different
// back-links and two indentations, and one of them carries an extra class on
// the anchor — folding those in would take more parameters than the duplication
// costs.
export const pageTitle = (
  text: string,
  { href = "/secret", hint = "Back to the secret menu" } = {},
): string =>
  `<a href="${esc(href)}" title="${esc(hint)}">\n` +
  `    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">\n` +
  `      ${esc(text)}\n` +
  `    </h1>\n` +
  `  </a>`;

// Shared chrome. `LINK_CLASS` is the standard inline link; `CARD_LIFT_CLASS`
// is the hover treatment on the home page's cards and buttons.
export const LINK_CLASS =
  "text-green-500 hover:text-green-400 underline cursor-pointer";

export const CARD_LIFT_CLASS =
  "transition-all duration-150 ease-out hover:border-green-500 " +
  "hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-2px_rgba(34,197,94,0.25)] " +
  "active:translate-y-0 active:shadow-none";

// An escaped link out to another site, opened in a new tab.
export const extLink = (
  url: string,
  text: string,
  cls = LINK_CLASS,
): string =>
  `<a href="${esc(url)}" target="_blank" rel="noopener" class="${cls}">${esc(text)}</a>`;

// Drops the scheme from a URL, for display as link text.
export const bareUrl = (url: string): string =>
  url.replace(/^https?:\/\//, "");
