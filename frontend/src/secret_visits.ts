// Visits overview. Fetches the high-level, anonymous aggregate from
// `/api/stats` (nginx reroutes `/api` to the backend's `/stats`) and renders it
// as three ApexCharts: visits per day, visits by kind, and visits by hour of
// day. Deliberately coarse — no IPs or per-visit detail live here; that's the
// job of the separate authenticated admin page.
//
// The backend already keeps asset fetches and bot/scanner probes at
// nonexistent paths out of every count above — they're not real page visits.
// That noise is surfaced here instead as its own `junk_total` tile and
// `by_junk_route` chart, so it's visible without polluting the real numbers.

// Type-only import: erased at build time, so ApexCharts stays out of the main
// bundle. The runtime library is pulled in on demand via dynamic `import()`
// below, keeping it off the critical path for everyone who never opens this
// rarely-visited page.
import type ApexCharts from "apexcharts";

type DayCount = { day: string; count: number };
type KindCount = { kind: string; count: number };
type HourCount = { hour: number; count: number };
type RouteCount = { route: string; count: number };

type Stats = {
  total: number;
  unique_visitors: number;
  // The page the aggregates are filtered to, or null when they span all pages.
  route: string | null;
  per_day: DayCount[];
  by_kind: KindCount[];
  by_hour: HourCount[];
  // Busiest pages overall — always all-pages, so it stays a stable picker menu.
  by_route: RouteCount[];
  // Visits at paths that aren't a known page — asset fetches and bot/scanner
  // probes — kept out of every count above. Always all-pages.
  junk_total: number;
  // The most-hit junk paths. Always all-pages.
  by_junk_route: RouteCount[];
};

// Shared palette, sampled from the site's green identity so all three charts
// read as one system.
const GREEN = "#22c55e";
const KIND_COLORS: Record<string, string> = {
  static: "#15803d",
  js: "#22c55e",
  secret: "#86efac",
};
const KIND_LABELS: Record<string, string> = {
  static: "Static (nginx)",
  js: "JavaScript ping",
  secret: "Secret",
};

// Options common to every chart: dark, chromeless, green-on-stone.
const baseOptions = (): Partial<ApexCharts.ApexOptions> => ({
  chart: {
    background: "transparent",
    foreColor: "#4d7c56", // muted green for axes/labels
    fontFamily: "ui-monospace, monospace",
    toolbar: { show: false },
    zoom: { enabled: false },
    animations: { speed: 400 },
  },
  theme: { mode: "dark" },
  grid: { borderColor: "#1c2a1e", strokeDashArray: 3 },
  tooltip: { theme: "dark" },
  dataLabels: { enabled: false },
});

const perDayOptions = (rows: DayCount[]): ApexCharts.ApexOptions => ({
  ...baseOptions(),
  series: [{ name: "Visits", data: rows.map((r) => r.count) }],
  chart: { ...baseOptions().chart, type: "area", height: 260 } as any,
  colors: [GREEN],
  stroke: { curve: "smooth", width: 2 },
  fill: {
    type: "gradient",
    gradient: { shadeIntensity: 1, opacityFrom: 0.35, opacityTo: 0.02 },
  },
  xaxis: {
    categories: rows.map((r) => r.day.slice(5)), // MM-DD
    tickAmount: 8,
    axisBorder: { color: "#1c2a1e" },
    axisTicks: { color: "#1c2a1e" },
  },
  yaxis: { min: 0, forceNiceScale: true },
});

const byHourOptions = (rows: HourCount[]): ApexCharts.ApexOptions => ({
  ...baseOptions(),
  series: [{ name: "Visits", data: rows.map((r) => r.count) }],
  chart: { ...baseOptions().chart, type: "bar", height: 260 } as any,
  colors: [GREEN],
  plotOptions: { bar: { columnWidth: "70%", borderRadius: 2 } },
  xaxis: {
    categories: rows.map((r) => String(r.hour).padStart(2, "0")),
    tickAmount: 12,
    axisBorder: { color: "#1c2a1e" },
    axisTicks: { color: "#1c2a1e" },
    title: { text: "Hour of day (local)", style: { color: "#4d7c56" } },
  },
  yaxis: { min: 0, forceNiceScale: true },
});

const byKindOptions = (rows: KindCount[]): ApexCharts.ApexOptions => ({
  ...baseOptions(),
  series: rows.map((r) => r.count),
  labels: rows.map((r) => KIND_LABELS[r.kind] ?? r.kind),
  chart: { ...baseOptions().chart, type: "donut", height: 260 } as any,
  colors: rows.map((r) => KIND_COLORS[r.kind] ?? GREEN),
  stroke: { colors: ["#0c0a09"], width: 2 },
  legend: { position: "bottom", labels: { colors: "#4d7c56" } },
  plotOptions: {
    pie: {
      donut: {
        labels: {
          show: true,
          total: { show: true, label: "Total", color: "#4d7c56" },
        },
      },
    },
  },
});

// Horizontal bars of the busiest pages. Clicking one filters every other chart
// to that page (see `onSelect`); the height grows with the row count so labels
// never crowd.
const byRouteOptions = (
  rows: RouteCount[],
  onSelect: (route: string) => void,
): ApexCharts.ApexOptions => ({
  ...baseOptions(),
  series: [{ name: "Visits", data: rows.map((r) => r.count) }],
  chart: {
    ...baseOptions().chart,
    type: "bar",
    height: Math.max(160, rows.length * 30),
    events: {
      dataPointSelection: (
        _e: unknown,
        _ctx: unknown,
        cfg: { dataPointIndex: number },
      ) => {
        const row = rows[cfg.dataPointIndex];
        if (row) onSelect(row.route);
      },
    },
  } as any,
  colors: [GREEN],
  plotOptions: { bar: { horizontal: true, borderRadius: 2, distributed: false } },
  xaxis: {
    categories: rows.map((r) => r.route),
    axisBorder: { color: "#1c2a1e" },
    axisTicks: { color: "#1c2a1e" },
  },
  yaxis: { labels: { style: { fontFamily: "ui-monospace, monospace" } } },
  states: { active: { filter: { type: "none" } } },
});

// Muted red, distinct from the green "real visit" palette — this chart is
// noise, not signal.
const JUNK_COLOR = "#991b1b";

// Horizontal bars of the most-hit junk paths — asset fetches and bot/scanner
// probes. Not clickable: these aren't real pages, so there's nothing to filter
// the other charts to.
const byJunkRouteOptions = (rows: RouteCount[]): ApexCharts.ApexOptions => ({
  ...baseOptions(),
  series: [{ name: "Hits", data: rows.map((r) => r.count) }],
  chart: {
    ...baseOptions().chart,
    type: "bar",
    height: Math.max(160, rows.length * 30),
  } as any,
  colors: [JUNK_COLOR],
  plotOptions: { bar: { horizontal: true, borderRadius: 2, distributed: false } },
  xaxis: {
    categories: rows.map((r) => r.route),
    axisBorder: { color: "#1c2a1e" },
    axisTicks: { color: "#1c2a1e" },
  },
  yaxis: { labels: { style: { fontFamily: "ui-monospace, monospace" } } },
});

// Charts live at module scope so the router can dispose them when navigating
// away — ApexCharts registers a window resize listener per chart that would
// otherwise fire against detached DOM. Mirrors `hideGame` for the canvas page.
let charts: ApexCharts[] = [];

export function disposeVisits(): void {
  for (const chart of charts) chart.destroy();
  charts = [];
}

// Escapes a page path for safe interpolation into `<option>` markup.
const esc = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

export default (app: HTMLElement) => {
  disposeVisits(); // drop any charts from a previous visit to this page

  // The page the aggregates are filtered to, or null for all pages. Reset on
  // every mount so re-entering the page always starts unfiltered.
  let currentRoute: string | null = null;

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Visits
    </h1>
  </a>

  <div class="w-full max-w-4xl mt-8 flex flex-col gap-6">
    <div id="vs-status" class="text-center text-green-800 italic">Loading visits…</div>

    <div id="vs-content" class="hidden flex-col gap-6">
      <div class="flex items-center justify-end gap-2 text-sm">
        <label for="vs-route" class="text-green-700">Page</label>
        <select id="vs-route" class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-2 py-1 text-green-300 font-mono max-w-[70%]">
          <option value="">All pages</option>
        </select>
      </div>

      <div class="grid grid-cols-3 gap-4">
        <div class="bg-stone-900 border border-green-900 rounded-lg px-4 py-5 text-center">
          <div class="text-3xl md:text-4xl font-bold font-mono text-green-300"><span id="vs-total">0</span></div>
          <div class="text-sm text-green-800 mt-1">Total visits</div>
        </div>
        <div class="bg-stone-900 border border-green-900 rounded-lg px-4 py-5 text-center">
          <div class="text-3xl md:text-4xl font-bold font-mono text-green-300"><span id="vs-unique">0</span></div>
          <div class="text-sm text-green-800 mt-1">Unique visitors</div>
        </div>
        <div class="bg-stone-900 border border-red-900 rounded-lg px-4 py-5 text-center" title="Asset fetches and bot/scanner probes at paths that aren't a real page — excluded from every count on this page">
          <div class="text-3xl md:text-4xl font-bold font-mono text-red-400"><span id="vs-junk">0</span></div>
          <div class="text-sm text-red-800 mt-1">Junk / bot hits</div>
        </div>
      </div>

      <div class="bg-stone-900 border border-green-900 rounded-lg p-4">
        <h2 class="text-green-400 font-mono text-sm mb-2">Visits per day &middot; last 30 days</h2>
        <div id="vs-per-day"></div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-stone-900 border border-green-900 rounded-lg p-4">
          <h2 class="text-green-400 font-mono text-sm mb-2">By source</h2>
          <div id="vs-by-kind"></div>
        </div>
        <div class="bg-stone-900 border border-green-900 rounded-lg p-4">
          <h2 class="text-green-400 font-mono text-sm mb-2">By hour of day</h2>
          <div id="vs-by-hour"></div>
        </div>
      </div>

      <div class="bg-stone-900 border border-green-900 rounded-lg p-4">
        <h2 class="text-green-400 font-mono text-sm mb-2">Top pages &middot; click to filter</h2>
        <div id="vs-by-route"></div>
      </div>

      <div id="vs-junk-panel" class="hidden bg-stone-900 border border-red-900 rounded-lg p-4">
        <h2 class="text-red-400 font-mono text-sm mb-2">Top junk paths &middot; asset fetches &amp; bot/scanner probes</h2>
        <div id="vs-by-junk-route"></div>
      </div>
    </div>
  </div>
</div>`;

  const statusEl = app.querySelector<HTMLDivElement>("#vs-status")!;
  const contentEl = app.querySelector<HTMLDivElement>("#vs-content")!;
  const routeSel = app.querySelector<HTMLSelectElement>("#vs-route")!;

  const render = (ApexChartsCtor: typeof ApexCharts, stats: Stats) => {
    disposeVisits(); // rebuild every chart cleanly on each (re)load

    (app.querySelector("#vs-total") as HTMLElement).textContent =
      stats.total.toLocaleString();
    (app.querySelector("#vs-unique") as HTMLElement).textContent =
      stats.unique_visitors.toLocaleString();
    (app.querySelector("#vs-junk") as HTMLElement).textContent =
      stats.junk_total.toLocaleString();

    // Rebuild the picker from the (always all-pages) `by_route` menu, then
    // restore the active selection — assigning `value` never fires `change`.
    routeSel.innerHTML =
      `<option value="">All pages</option>` +
      stats.by_route
        .map((r) => `<option value="${esc(r.route)}">${esc(r.route)}</option>`)
        .join("");
    routeSel.value = currentRoute ?? "";

    statusEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    contentEl.classList.add("flex");

    const mount = (sel: string, options: ApexCharts.ApexOptions) => {
      const el = app.querySelector<HTMLElement>(sel);
      if (!el) return;
      const chart = new ApexChartsCtor(el, options);
      chart.render();
      charts.push(chart);
    };

    mount("#vs-per-day", perDayOptions(stats.per_day));
    mount("#vs-by-kind", byKindOptions(stats.by_kind));
    mount("#vs-by-hour", byHourOptions(stats.by_hour));
    mount(
      "#vs-by-route",
      byRouteOptions(stats.by_route, (route) => {
        currentRoute = route;
        load();
      }),
    );

    // Only take up room when there's actually junk to show.
    const junkPanel = app.querySelector<HTMLElement>("#vs-junk-panel")!;
    junkPanel.classList.toggle("hidden", stats.by_junk_route.length === 0);
    if (stats.by_junk_route.length > 0) {
      mount("#vs-by-junk-route", byJunkRouteOptions(stats.by_junk_route));
    }
  };

  // Guards against a slow fetch landing after a newer one (e.g. clicking two
  // different route filters in quick succession) — without this, the stale
  // response could win the race and clobber the freshly-rendered charts with
  // outdated data.
  let requestId = 0;

  const load = async () => {
    const id = ++requestId;
    try {
      // Bucket days/hours in the viewer's own timezone. The backend hands the
      // IANA name to Postgres' `AT TIME ZONE`, so DST is handled correctly.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const url =
        `/api/stats?tz=${encodeURIComponent(tz)}` +
        (currentRoute ? `&route=${encodeURIComponent(currentRoute)}` : "");
      const [{ default: ApexChartsCtor }, res] = await Promise.all([
        import("apexcharts"),
        fetch(url),
      ]);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const stats = (await res.json()) as Stats;
      if (id !== requestId) return; // a newer load superseded this one
      // Guard against the user navigating away while the chunk/fetch was in
      // flight — the router would have cleared this page's DOM.
      if (!document.body.contains(statusEl)) return;
      render(ApexChartsCtor, stats);
    } catch {
      if (id !== requestId) return;
      if (document.body.contains(statusEl)) {
        statusEl.textContent = "Network error — is the API up?";
        statusEl.classList.remove("hidden");
      }
    }
  };

  routeSel.onchange = () => {
    currentRoute = routeSel.value || null;
    load();
  };

  load();
};
