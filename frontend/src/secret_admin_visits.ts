// Admin visits page — the detailed, IP-level view the public `/secret/visits`
// overview deliberately withholds. Every call uses `credentials: "include"` so
// the HttpOnly session cookie set at login is sent along. On load we check
// `/api/auth/me`; anyone who isn't a signed-in admin is bounced to the secret
// menu. Admins get a paginated table of raw visits (time, source, page, client
// IP, user agent) from `/api/admin/visits`, filterable by kind and by clicking a
// page path.

type Me = { id: string; name: string; role: string };
type Visit = {
  id: string;
  created_at: string;
  kind: string;
  route: string | null;
  client_ip: string;
  user_agent: string;
};
type VisitsPage = {
  total: number;
  limit: number;
  offset: number;
  visits: Visit[];
};

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

const errorText = async (res: Response): Promise<string> => {
  const body = await res.json().catch(() => null);
  if (body && typeof body.error === "string") return body.error;
  return `Error ${res.status}`;
};

const fmtDate = (iso: string): string => new Date(iso).toLocaleString();

// Escapes text for safe interpolation into table markup.
const esc = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

const KINDS = ["static", "js", "secret"] as const;
const KIND_LABELS: Record<string, string> = {
  static: "static",
  js: "js",
  secret: "secret",
};
// Badge tints, sampled from the visits overview so the two pages read as one.
const KIND_CLASS: Record<string, string> = {
  static: "text-green-700",
  js: "text-green-400",
  secret: "text-lime-300",
};

const PAGE_SIZE = 100;

export default async (app: HTMLElement) => {
  // Gate: only signed-in admins may see this page.
  try {
    const res = await api("/auth/me");
    if (!res.ok) return window.navigate("/secret");
    const me: Me = await res.json();
    if (me.role !== "admin") return window.navigate("/secret");
  } catch {
    return window.navigate("/secret");
  }

  // View state, reset on every mount.
  let offset = 0;
  let kind: string | null = null;
  let route: string | null = null;

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <div class="w-full max-w-5xl flex items-center justify-between">
    <a href="/secret/admin" title="Back to admin">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Visits
      </h1>
    </a>
    <a href="/secret/admin" class="text-sm text-green-700 hover:text-green-400">&larr; admin</a>
  </div>

  <div class="w-full max-w-5xl mt-8 flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="text-green-700 mr-1">Source</span>
      <div id="vz-kinds" class="flex flex-wrap gap-2"></div>
      <div id="vz-route-filter" class="hidden ml-auto items-center gap-2"></div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-left font-mono text-sm">
        <thead class="text-green-700 border-b border-green-900">
          <tr>
            <th class="py-2 pr-4 whitespace-nowrap">Time</th>
            <th class="py-2 pr-4">Source</th>
            <th class="py-2 pr-4">Page</th>
            <th class="py-2 pr-4">IP</th>
            <th class="py-2">User agent</th>
          </tr>
        </thead>
        <tbody id="vz-rows" class="text-green-300"></tbody>
      </table>
    </div>

    <div class="flex items-center justify-between text-sm text-green-700">
      <span id="vz-range">—</span>
      <div class="flex items-center gap-2">
        <button id="vz-prev" class="px-3 py-1 border border-green-900 rounded hover:border-green-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">prev</button>
        <button id="vz-next" class="px-3 py-1 border border-green-900 rounded hover:border-green-600 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer">next</button>
      </div>
    </div>
  </div>
</div>`;

  const kindsEl = app.querySelector<HTMLDivElement>("#vz-kinds")!;
  const routeFilterEl = app.querySelector<HTMLDivElement>("#vz-route-filter")!;
  const rowsEl = app.querySelector<HTMLTableSectionElement>("#vz-rows")!;
  const rangeEl = app.querySelector<HTMLSpanElement>("#vz-range")!;
  const prevBtn = app.querySelector<HTMLButtonElement>("#vz-prev")!;
  const nextBtn = app.querySelector<HTMLButtonElement>("#vz-next")!;

  // --- kind filter chips ---------------------------------------------------
  const renderKindChips = () => {
    kindsEl.innerHTML = "";
    const chip = (value: string | null, label: string) => {
      const active = kind === value;
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.className = `rounded-full px-3 py-1 border cursor-pointer transition-colors ${
        active
          ? "bg-green-700 border-green-700 text-white"
          : "border-green-900 text-green-400 hover:bg-green-900/40 hover:text-green-200"
      }`;
      btn.onclick = () => {
        if (kind === value) return;
        kind = value;
        offset = 0;
        renderKindChips();
        load();
      };
      kindsEl.appendChild(btn);
    };
    chip(null, "all");
    for (const k of KINDS) chip(k, KIND_LABELS[k]);
  };

  // --- active route filter -------------------------------------------------
  const renderRouteFilter = () => {
    if (!route) {
      routeFilterEl.classList.add("hidden");
      routeFilterEl.classList.remove("flex");
      routeFilterEl.innerHTML = "";
      return;
    }
    routeFilterEl.classList.remove("hidden");
    routeFilterEl.classList.add("flex");
    routeFilterEl.innerHTML = `
      <span class="text-green-700">Page</span>
      <code class="text-green-300">${esc(route)}</code>
      <button id="vz-route-clear" class="text-green-700 hover:text-green-400 cursor-pointer">clear</button>`;
    routeFilterEl.querySelector<HTMLButtonElement>("#vz-route-clear")!.onclick =
      () => {
        route = null;
        offset = 0;
        renderRouteFilter();
        load();
      };
  };

  // --- table ---------------------------------------------------------------
  const renderRows = (visits: Visit[]) => {
    rowsEl.innerHTML = "";
    if (visits.length === 0) {
      rowsEl.innerHTML = `<tr><td colspan="5" class="py-4 text-green-800 italic">No visits match.</td></tr>`;
      return;
    }
    for (const v of visits) {
      const tr = document.createElement("tr");
      tr.className = "border-b border-green-900/40 align-top";
      const kindClass = KIND_CLASS[v.kind] ?? "text-green-400";
      const routeCell = v.route
        ? `<button class="vz-route-link text-green-300 hover:text-green-100 hover:underline cursor-pointer text-left" data-route="${esc(v.route)}">${esc(v.route)}</button>`
        : `<span class="text-green-800">—</span>`;
      tr.innerHTML = `
        <td class="py-2 pr-4 whitespace-nowrap text-green-700">${fmtDate(v.created_at)}</td>
        <td class="py-2 pr-4 ${kindClass}">${esc(KIND_LABELS[v.kind] ?? v.kind)}</td>
        <td class="py-2 pr-4 break-all">${routeCell}</td>
        <td class="py-2 pr-4 whitespace-nowrap text-green-400">${esc(v.client_ip)}</td>
        <td class="py-2 text-green-800 break-all max-w-md">${esc(v.user_agent) || "—"}</td>`;
      rowsEl.appendChild(tr);
    }
    // Clicking a page path filters the table to it.
    rowsEl.querySelectorAll<HTMLButtonElement>(".vz-route-link").forEach((el) => {
      el.onclick = () => {
        route = el.dataset.route ?? null;
        offset = 0;
        renderRouteFilter();
        load();
      };
    });
  };

  // --- fetch + pagination --------------------------------------------------
  const load = async () => {
    rangeEl.textContent = "Loading…";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (kind) params.set("kind", kind);
      if (route) params.set("route", route);
      const res = await api(`/admin/visits?${params}`);
      if (!res.ok) {
        rowsEl.innerHTML = `<tr><td colspan="5" class="py-4 text-red-400">${await errorText(res)}</td></tr>`;
        rangeEl.textContent = "—";
        return;
      }
      const page: VisitsPage = await res.json();
      // Guard against navigating away mid-fetch — the router clears the DOM.
      if (!document.body.contains(rowsEl)) return;

      renderRows(page.visits);
      const first = page.total === 0 ? 0 : page.offset + 1;
      const last = page.offset + page.visits.length;
      rangeEl.textContent = `${first}–${last} of ${page.total.toLocaleString()}`;
      prevBtn.disabled = page.offset <= 0;
      nextBtn.disabled = last >= page.total;
    } catch {
      if (document.body.contains(rowsEl)) {
        rowsEl.innerHTML = `<tr><td colspan="5" class="py-4 text-red-400">Network error — is the API up?</td></tr>`;
        rangeEl.textContent = "—";
      }
    }
  };

  prevBtn.onclick = () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    load();
  };
  nextBtn.onclick = () => {
    offset += PAGE_SIZE;
    load();
  };

  renderKindChips();
  renderRouteFilter();
  await load();
};
