// Visits overview. Fetches the high-level, anonymous aggregate from
// `/api/stats` (nginx reroutes `/api` to the backend's `/stats`) and renders it
// as three ApexCharts: visits per day, visits by kind, and visits by hour of
// day. Deliberately coarse — no IPs or per-visit detail live here; that's the
// job of the separate authenticated admin page.
//
// The backend already keeps asset fetches and bot/scanner probes at
// nonexistent paths out of every count above — they're not real page visits.
// That noise is surfaced here instead, split into a green `static_total` tile
// (asset fetches like `/chip.svg`) and a red `robot_total` tile (scanner probes
// plus crawler paths like `/robots.txt`), so it's visible — and the genuine
// asset loads are told apart from bots — without polluting the real numbers.

// Type-only import: erased at build time, so ApexCharts stays out of the main
// bundle. The runtime library is pulled in on demand via dynamic `import()`
// below, keeping it off the critical path for everyone who never opens this
// rarely-visited page.
import { PAGE_CLASS, pageTitle } from "./helpers";
import type ApexCharts from "apexcharts";

// Generated from `stats.rs` — see `backend/build.rs`. The per-field comments
// that used to live here are carried through as JSDoc on the generated types.
import type { DayCount, HourCount, KindCount, RouteCount, Stats } from "@andrewmccall/api-types";

// Shared palette, sampled from the site's green identity so all three charts
// read as one system.
const GREEN = "#22c55e";
const KIND_COLORS: Record<string, string> = {
  static: "#15803d",
  js: "#22c55e",
  secret: "#86efac",
  robot: "#991b1b", // muted red — bot/scanner noise, matched to the robot tile
};
const KIND_LABELS: Record<string, string> = {
  static: "Static (nginx)",
  js: "JavaScript ping",
  secret: "Secret",
  robot: "Robot / bot",
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
  // Log scale so a few very-busy days don't flatten every quieter day to the
  // baseline. `min: 1` keeps the axis defined (log 0 is undefined) — zero-visit
  // days from `generate_series` just sit on the floor.
  yaxis: { logarithmic: true, min: 1, forceNiceScale: true },
});

const byHourOptions = (rows: HourCount[]): ApexCharts.ApexOptions => {
  const counts = rows.map((r) => r.count);
  return {
    ...baseOptions(),
    // Combo chart: the bars carry the reading, with a smooth line tracing the
    // same values behind them for a sense of the shape across the day.
    series: [
      { name: "Visits", type: "column", data: counts },
      { name: "Trend", type: "line", data: counts },
    ],
    chart: { ...baseOptions().chart, type: "line", height: 260 } as any,
    colors: [GREEN, "#86efac"],
    // No stroke on the bars; a thin smooth stroke on the line.
    stroke: { width: [0, 2], curve: "smooth" },
    plotOptions: { bar: { columnWidth: "70%", borderRadius: 2 } },
    markers: { size: 0 },
    legend: { show: false },
    // Both series hold identical data, so only surface the bar in the tooltip.
    tooltip: { theme: "dark", shared: false, enabledOnSeries: [0] },
    xaxis: {
      categories: rows.map((r) => String(r.hour).padStart(2, "0")),
      tickAmount: 12,
      axisBorder: { color: "#1c2a1e" },
      axisTicks: { color: "#1c2a1e" },
      title: { text: "Hour of day (local)", style: { color: "#4d7c56" } },
    },
    yaxis: { min: 0, forceNiceScale: true },
  };
};

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

// Log-scale a count for bar length. `+1` keeps a single-hit page visible
// instead of collapsing log10(1)=0 to a zero-width bar, and lets zero-hit rows
// sit flat on the baseline. Inverted by `barAxisValue` to recover the count.
const logScale = (n: number): number => Math.log10(n + 1);

// The bar-length value for a count under the chosen scale. When `log` is off
// the series carries the raw counts; ApexCharts ignores its own `logarithmic`
// flag on horizontal bars, so log mode scales the lengths here instead.
const barValue = (n: number, log: boolean): number => (log ? logScale(n) : n);

// Recover the real count from a value-axis position, undoing `barValue`.
const barAxisValue = (v: string, log: boolean): string => {
  const n = log ? Math.round(10 ** Number(v) - 1) : Math.round(Number(v));
  return n <= 0 ? "0" : n.toLocaleString();
};

// A count-per-row formatter for data labels and tooltips, reading the true
// count out of `rows` by point index so it's correct under either scale.
const rowCount =
  (rows: RouteCount[]) =>
  (_v: number, opts?: { dataPointIndex: number }): string =>
    (opts ? rows[opts.dataPointIndex]?.count.toLocaleString() : "") ?? "";

// Horizontal bars of the busiest pages. Clicking one filters every other chart
// to that page (see `onSelect`); the height grows with the row count so labels
// never crowd. `log` toggles a hand-rolled logarithmic scale (see `barValue`)
// so a single runaway page doesn't crush every quieter page to a sliver; the
// axis, data labels, and tooltip always read in real counts.
const byRouteOptions = (
  rows: RouteCount[],
  log: boolean,
  onSelect: (route: string) => void,
): ApexCharts.ApexOptions => ({
  ...baseOptions(),
  series: [{ name: "Visits", data: rows.map((r) => barValue(r.count, log)) }],
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
  // Print the real count at the end of each bar, since a log-scaled axis makes
  // exact lengths hard to read off.
  dataLabels: {
    enabled: true,
    formatter: rowCount(rows),
    offsetX: 24,
    // White so the count stays legible on top of the green/red bars — the muted
    // green blends into them. Reads fine on the dark card too, for tiny bars
    // whose label falls off the end onto the background.
    style: { colors: ["#ffffff"], fontFamily: "ui-monospace, monospace" },
  },
  xaxis: {
    categories: rows.map((r) => r.route),
    axisBorder: { color: "#1c2a1e" },
    axisTicks: { color: "#1c2a1e" },
    labels: { formatter: (v: string) => barAxisValue(v, log) },
  },
  yaxis: { labels: { style: { fontFamily: "ui-monospace, monospace" } } },
  tooltip: { theme: "dark", y: { formatter: rowCount(rows) } },
  states: { active: { filter: { type: "none" } } },
});

// Muted red for robot/scanner noise; a muted green for static-asset fetches,
// which are real resource loads rather than spam.
const ROBOT_COLOR = "#991b1b";
const STATIC_COLOR = "#15803d";

// Horizontal bars of the most-hit non-page paths, tinted by `color` so static
// assets (green) and robot noise (red) read apart. Not clickable: these aren't
// real pages, so there's nothing to filter the other charts to. `log` behaves
// exactly as in `byRouteOptions`.
const byNoiseRouteOptions = (
  rows: RouteCount[],
  color: string,
  log: boolean,
): ApexCharts.ApexOptions => ({
  ...baseOptions(),
  series: [{ name: "Hits", data: rows.map((r) => barValue(r.count, log)) }],
  chart: {
    ...baseOptions().chart,
    type: "bar",
    height: Math.max(160, rows.length * 30),
  } as any,
  colors: [color],
  plotOptions: { bar: { horizontal: true, borderRadius: 2, distributed: false } },
  dataLabels: {
    enabled: true,
    formatter: rowCount(rows),
    offsetX: 24,
    // White so the count stays legible on top of the green/red bars — the muted
    // green blends into them. Reads fine on the dark card too, for tiny bars
    // whose label falls off the end onto the background.
    style: { colors: ["#ffffff"], fontFamily: "ui-monospace, monospace" },
  },
  xaxis: {
    categories: rows.map((r) => r.route),
    axisBorder: { color: "#1c2a1e" },
    axisTicks: { color: "#1c2a1e" },
    labels: { formatter: (v: string) => barAxisValue(v, log) },
  },
  yaxis: { labels: { style: { fontFamily: "ui-monospace, monospace" } } },
  tooltip: { theme: "dark", y: { formatter: rowCount(rows) } },
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

  // Per-card log/linear scale for the three horizontal-bar charts. Kept at mount
  // scope so a toggle sticks across route filtering and reloads. Default log.
  const logScales = { route: true, static: true, robot: true };

  app.innerHTML = `
<div class="${PAGE_CLASS}">
  ${pageTitle("Visits")}

  <div class="w-full max-w-4xl mt-8 flex flex-col gap-6">
    <div id="vs-status" class="text-center text-green-800 italic">Loading visits…</div>

    <div id="vs-content" class="hidden flex-col gap-6">
      <div class="flex items-center justify-end gap-2 text-sm">
        <label for="vs-route" class="text-green-700">Page</label>
        <select id="vs-route" class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-2 py-1 text-green-300 font-mono max-w-[70%]">
          <option value="">All pages</option>
        </select>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="bg-stone-900 border border-green-900 px-4 py-5 text-center">
          <div class="text-3xl md:text-4xl font-bold font-mono text-green-300"><span id="vs-total">0</span></div>
          <div class="text-sm text-green-800 mt-1">Total hits</div>
        </div>
        <div class="bg-stone-900 border border-green-900 px-4 py-5 text-center">
          <div class="text-3xl md:text-4xl font-bold font-mono text-green-300"><span id="vs-unique">0</span></div>
          <div class="text-sm text-green-800 mt-1">Unique visitors</div>
        </div>
        <div class="bg-stone-900 border border-green-900 px-4 py-5 text-center" title="Asset fetches at paths that aren't a real page (/chip.svg, /assets/bundle-*.js, .css) — real resource loads, excluded from every count on this page">
          <div class="text-3xl md:text-4xl font-bold font-mono text-green-300"><span id="vs-static">0</span></div>
          <div class="text-sm text-green-800 mt-1">Static assets</div>
        </div>
        <div class="bg-stone-900 border border-red-900 px-4 py-5 text-center" title="Bot/scanner probes at paths that aren't a real page, plus crawler fetches of /robots.txt — excluded from every count on this page">
          <div class="text-3xl md:text-4xl font-bold font-mono text-red-400"><span id="vs-robot">0</span></div>
          <div class="text-sm text-red-800 mt-1">Robot / bot hits</div>
        </div>
      </div>

      <div class="bg-stone-900 border border-green-900 p-4">
        <h2 class="text-green-400 font-mono text-sm mb-2">Visits per day &middot; last 30 days</h2>
        <div id="vs-per-day"></div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div id="vs-by-kind-panel" class="bg-stone-900 border border-green-900 p-4">
          <h2 class="text-green-400 font-mono text-sm mb-2">By source</h2>
          <div id="vs-by-kind"></div>
        </div>
        <div id="vs-by-hour-panel" class="bg-stone-900 border border-green-900 p-4">
          <h2 class="text-green-400 font-mono text-sm mb-2">By hour of day</h2>
          <div id="vs-by-hour"></div>
        </div>
      </div>

      <div class="relative bg-stone-900 border border-green-900 p-4">
        <button id="vs-by-route-log" type="button" class="absolute top-3 right-3 z-10 text-xs font-mono px-2 py-0.5 border border-green-900 text-green-600 hover:border-green-600 hover:text-green-300">log</button>
        <h2 class="text-green-400 font-mono text-sm mb-2">Top pages &middot; click to filter</h2>
        <div id="vs-by-route"></div>
      </div>

      <div id="vs-static-panel" class="relative hidden bg-stone-900 border border-green-900 p-4">
        <button id="vs-by-static-route-log" type="button" class="absolute top-3 right-3 z-10 text-xs font-mono px-2 py-0.5 border border-green-900 text-green-600 hover:border-green-600 hover:text-green-300">log</button>
        <h2 class="text-green-400 font-mono text-sm mb-2">Top static-asset paths &middot; .js / .css / .svg &amp; friends</h2>
        <div id="vs-by-static-route"></div>
      </div>

      <div id="vs-robot-panel" class="relative hidden bg-stone-900 border border-red-900 p-4">
        <button id="vs-by-robot-route-log" type="button" class="absolute top-3 right-3 z-10 text-xs font-mono px-2 py-0.5 border border-red-900 text-red-600 hover:border-red-600 hover:text-red-300">log</button>
        <h2 class="text-red-400 font-mono text-sm mb-2">Top robot paths &middot; bot/scanner probes &amp; robots.txt</h2>
        <div id="vs-by-robot-route"></div>
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
    (app.querySelector("#vs-static") as HTMLElement).textContent =
      stats.static_total.toLocaleString();
    (app.querySelector("#vs-robot") as HTMLElement).textContent =
      stats.robot_total.toLocaleString();

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

    const mount = (
      sel: string,
      options: ApexCharts.ApexOptions,
    ): ApexCharts | null => {
      const el = app.querySelector<HTMLElement>(sel);
      if (!el) return null;
      const chart = new ApexChartsCtor(el, options);
      chart.render();
      charts.push(chart);
      return chart;
    };

    // Wire a card's log/linear button to its chart. `build` re-derives the
    // options for the current scale; toggling updates the chart in place and
    // relabels the button. No-ops if the chart never mounted (empty panel).
    const wireScale = (
      btnSel: string,
      chart: ApexCharts | null,
      key: keyof typeof logScales,
      build: () => ApexCharts.ApexOptions,
    ) => {
      const btn = app.querySelector<HTMLButtonElement>(btnSel);
      if (!btn || !chart) return;
      btn.textContent = logScales[key] ? "logarithmic" : "linear";
      btn.onclick = () => {
        logScales[key] = !logScales[key];
        btn.textContent = logScales[key] ? "logarithmic" : "linear";
        chart.updateOptions(build(), true, false);
      };
    };

    mount("#vs-per-day", perDayOptions(stats.per_day));
    // The source breakdown only makes sense site-wide. `robot_total` always
    // spans every page (bot probes hit paths that were never real, so they
    // belong to no page) and `by_kind` on a filtered page collapses to a single
    // slice, so the donut carries no signal there — hide the whole panel when a
    // page is selected, and fold the robot noise in as its own (red) slice in
    // the all-pages view so the donut accounts for every hit.
    const kindPanel = app.querySelector<HTMLElement>("#vs-by-kind-panel")!;
    kindPanel.classList.toggle("hidden", currentRoute !== null);
    // With the source panel gone on a filtered page, let the hour chart claim
    // both grid columns instead of leaving a hole beside it.
    app
      .querySelector<HTMLElement>("#vs-by-hour-panel")!
      .classList.toggle("md:col-span-2", currentRoute !== null);
    if (currentRoute === null) {
      const kindRows =
        stats.robot_total > 0
          ? [...stats.by_kind, { kind: "robot", count: stats.robot_total }]
          : stats.by_kind;
      mount("#vs-by-kind", byKindOptions(kindRows));
    }
    mount("#vs-by-hour", byHourOptions(stats.by_hour));
    const onSelect = (route: string) => {
      currentRoute = route;
      load();
    };
    const routeBuild = () =>
      byRouteOptions(stats.by_route, logScales.route, onSelect);
    wireScale(
      "#vs-by-route-log",
      mount("#vs-by-route", routeBuild()),
      "route",
      routeBuild,
    );

    // Only take up room when there's actually noise to show, and keep the
    // static (green) and robot (red) breakdowns on their own panels.
    const noisePanel = (
      panelSel: string,
      chartSel: string,
      btnSel: string,
      rows: RouteCount[],
      color: string,
      key: "static" | "robot",
    ) => {
      const panel = app.querySelector<HTMLElement>(panelSel)!;
      panel.classList.toggle("hidden", rows.length === 0);
      if (rows.length === 0) return;
      const build = () => byNoiseRouteOptions(rows, color, logScales[key]);
      wireScale(btnSel, mount(chartSel, build()), key, build);
    };
    noisePanel(
      "#vs-static-panel",
      "#vs-by-static-route",
      "#vs-by-static-route-log",
      stats.by_static_route,
      STATIC_COLOR,
      "static",
    );
    noisePanel(
      "#vs-robot-panel",
      "#vs-by-robot-route",
      "#vs-by-robot-route-log",
      stats.by_robot_route,
      ROBOT_COLOR,
      "robot",
    );
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
