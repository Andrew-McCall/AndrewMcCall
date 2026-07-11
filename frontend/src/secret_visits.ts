// Visits overview. Fetches the high-level, anonymous aggregate from
// `/api/stats` (nginx reroutes `/api` to the backend's `/stats`) and renders it
// as three ApexCharts: visits per day, visits by kind, and visits by hour of
// day. Deliberately coarse — no IPs or per-visit detail live here; that's the
// job of the separate authenticated admin page.

// Type-only import: erased at build time, so ApexCharts stays out of the main
// bundle. The runtime library is pulled in on demand via dynamic `import()`
// below, keeping it off the critical path for everyone who never opens this
// rarely-visited page.
import type ApexCharts from "apexcharts";

type DayCount = { day: string; count: number };
type KindCount = { kind: string; count: number };
type HourCount = { hour: number; count: number };

type Stats = {
  total: number;
  unique_visitors: number;
  per_day: DayCount[];
  by_kind: KindCount[];
  by_hour: HourCount[];
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
    title: { text: "Hour of day (UTC)", style: { color: "#4d7c56" } },
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

// Charts live at module scope so the router can dispose them when navigating
// away — ApexCharts registers a window resize listener per chart that would
// otherwise fire against detached DOM. Mirrors `hideGame` for the canvas page.
let charts: ApexCharts[] = [];

export function disposeVisits(): void {
  for (const chart of charts) chart.destroy();
  charts = [];
}

export default (app: HTMLElement) => {
  disposeVisits(); // drop any charts from a previous visit to this page
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
      <div class="grid grid-cols-2 gap-4">
        <div class="bg-stone-900 border border-green-900 rounded-lg px-4 py-5 text-center">
          <div class="text-3xl md:text-4xl font-bold font-mono text-green-300"><span id="vs-total">0</span></div>
          <div class="text-sm text-green-800 mt-1">Total visits</div>
        </div>
        <div class="bg-stone-900 border border-green-900 rounded-lg px-4 py-5 text-center">
          <div class="text-3xl md:text-4xl font-bold font-mono text-green-300"><span id="vs-unique">0</span></div>
          <div class="text-sm text-green-800 mt-1">Unique visitors</div>
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
    </div>
  </div>
</div>`;

  const statusEl = app.querySelector<HTMLDivElement>("#vs-status")!;
  const contentEl = app.querySelector<HTMLDivElement>("#vs-content")!;

  const render = (
    ApexChartsCtor: typeof ApexCharts,
    stats: Stats,
  ) => {
    (app.querySelector("#vs-total") as HTMLElement).textContent =
      stats.total.toLocaleString();
    (app.querySelector("#vs-unique") as HTMLElement).textContent =
      stats.unique_visitors.toLocaleString();

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
  };

  const init = async () => {
    try {
      const [{ default: ApexChartsCtor }, res] = await Promise.all([
        import("apexcharts"),
        fetch("/api/stats"),
      ]);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const stats = (await res.json()) as Stats;
      // Guard against the user navigating away while the chunk/fetch was in
      // flight — the router would have cleared this page's DOM.
      if (!document.body.contains(statusEl)) return;
      render(ApexChartsCtor, stats);
    } catch {
      if (document.body.contains(statusEl))
        statusEl.textContent = "Network error — is the API up?";
    }
  };

  init();
};
