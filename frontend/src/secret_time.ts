// Time helper — a self-contained, dependency-free grab-bag of time tools:
// a Unix timestamp converter, an any-to-many timezone converter, a live
// relative-time formatter, and a cron parser + builder that share one engine.
// Everything is plain DOM + the Intl APIs the browser already ships; nothing
// is fetched or bundled. A single tab strip swaps between the panels.

type Tab = "unix" | "tz" | "relative" | "cron";

// The relative-time tab runs a 1s ticker while it's on screen; this tears it
// down. Set on mount, called by the router on navigation away (see main.ts) —
// mirroring the disposeX pattern used by secret_pi / secret_morse /
// secret_canvas, rather than the removed/deprecated DOMNodeRemovedFromDocument
// mutation event, which modern browsers (Chrome included) no longer fire, so
// the interval would otherwise tick forever in the background after leaving.
let teardown: (() => void) | null = null;

export function disposeTime(): void {
  teardown?.();
  teardown = null;
}

// Escapes text for safe interpolation into innerHTML.
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

// A datetime-local input value (no seconds) for a given Date, in local time.
const toLocalInput = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;

// ---------------------------------------------------------------------------
// Cron engine — shared by the parser and the builder.
// Standard 5-field cron: minute hour day-of-month month day-of-week.
// Supports  *  a  a-b  a-b/n  */n  and comma lists of those.
// ---------------------------------------------------------------------------

interface CronField {
  min: number;
  max: number;
  name: string;
  // Optional labels for pretty-printing (months, weekdays).
  labels?: string[];
  // Alias names accepted on input (JAN, MON, …) mapped to numbers.
  aliases?: Record<string, number>;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const monthAliases: Record<string, number> = {};
MONTHS.forEach((m, i) => (monthAliases[m.slice(0, 3).toUpperCase()] = i + 1));
const dowAliases: Record<string, number> = {};
WEEKDAYS.forEach((d, i) => (dowAliases[d.slice(0, 3).toUpperCase()] = i));

const CRON_FIELDS: CronField[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month", labels: MONTHS, aliases: monthAliases },
  {
    min: 0,
    max: 6,
    name: "day-of-week",
    labels: WEEKDAYS,
    aliases: dowAliases,
  },
];

// Named shortcuts accepted in the parser.
const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface ParsedField {
  values: Set<number>;
  restricted: boolean; // false === "*" (matches everything)
  spec: string; // original text, for messages
}

// Expand one field into the set of numbers it allows. Throws on bad input.
const parseField = (raw: string, field: CronField): ParsedField => {
  const resolve = (tok: string): number => {
    const up = tok.toUpperCase();
    if (field.aliases && up in field.aliases) return field.aliases[up];
    if (!/^\d+$/.test(tok))
      throw new Error(`invalid ${field.name} value "${tok}"`);
    return parseInt(tok, 10);
  };

  const values = new Set<number>();
  const restricted = raw !== "*";

  for (const part of raw.split(",")) {
    if (part === "") throw new Error(`empty ${field.name} entry`);
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : parseInt(stepPart, 10);
    if (stepPart !== undefined && (!/^\d+$/.test(stepPart) || step < 1))
      throw new Error(`invalid step "/${stepPart}" in ${field.name}`);

    let lo: number, hi: number;
    if (rangePart === "*") {
      lo = field.min;
      hi = field.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = resolve(a);
      hi = resolve(b);
    } else {
      lo = hi = resolve(rangePart);
      // day-of-week 7 is an accepted alias for Sunday (0).
      if (field.name === "day-of-week" && lo === 7) lo = hi = 0;
    }

    if (field.name === "day-of-week") {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < field.min || hi > field.max || lo > hi)
      throw new Error(
        `${field.name} value out of range (${field.min}-${field.max}): "${part}"`,
      );

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return { values, restricted, spec: raw };
};

interface ParsedCron {
  fields: ParsedField[]; // [minute, hour, dom, month, dow]
}

const parseCron = (input: string): ParsedCron => {
  let expr = input.trim().replace(/\s+/g, " ");
  if (expr in CRON_MACROS) expr = CRON_MACROS[expr];
  if (expr.startsWith("@"))
    throw new Error(`unknown macro "${expr.split(" ")[0]}"`);

  const parts = expr.split(" ");
  if (parts.length !== 5)
    throw new Error(
      `expected 5 fields, got ${parts.length} (minute hour day month weekday)`,
    );

  const fields = parts.map((p, i) => parseField(p, CRON_FIELDS[i]));
  return { fields };
};

// Does `date` (local time) satisfy the day-of-month / day-of-week rules?
// Cron quirk: if BOTH are restricted, a match on EITHER counts (OR); if only
// one is restricted, only that one applies.
const dayMatches = (
  date: Date,
  dom: ParsedField,
  dow: ParsedField,
): boolean => {
  const domOk = dom.values.has(date.getDate());
  const dowOk = dow.values.has(date.getDay());
  if (dom.restricted && dow.restricted) return domOk || dowOk;
  if (dom.restricted) return domOk;
  if (dow.restricted) return dowOk;
  return true; // both "*"
};

// Compute the next `count` fire times at or after `from`, in local time.
const nextCronRuns = (cron: ParsedCron, from: Date, count: number): Date[] => {
  const [minute, hour, dom, month, dow] = cron.fields;
  const runs: Date[] = [];

  // Start at the next whole minute after `from`.
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  let guard = 0;
  const GUARD_MAX = 500_000; // ample; bails on impossible expressions.
  while (runs.length < count && guard++ < GUARD_MAX) {
    if (!month.values.has(d.getMonth() + 1)) {
      // Jump to the 1st of the next month at 00:00.
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(d, dom, dow)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    runs.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1);
  }
  return runs;
};

// Render one field to English (e.g. "every 15 minutes", "at 9").
const describeField = (f: ParsedField, field: CronField): string => {
  if (!f.restricted) return "every " + field.name;

  const labelOf = (n: number) =>
    field.labels?.[field.name === "month" ? n - 1 : n] ?? String(n);

  // Detect a clean "*/n" step over the whole range.
  const sorted = [...f.values].sort((a, b) => a - b);
  if (sorted.length > 1 && sorted[0] === field.min && !field.labels) {
    const step = sorted[1] - sorted[0];
    const isEven = sorted.every((v, i) => v === field.min + i * step);
    const coversRange = sorted[sorted.length - 1] + step > field.max;
    if (isEven && coversRange && step > 1)
      return `every ${step} ${field.name}s`;
  }

  const list = sorted.map(labelOf).join(", ");
  return `${field.name} ${list}`;
};

const describeCron = (cron: ParsedCron): string => {
  const [minute, hour, dom, month, dow] = cron.fields;
  const parts: string[] = [];

  // Time-of-day.
  if (
    minute.restricted &&
    hour.restricted &&
    minute.values.size === 1 &&
    hour.values.size === 1
  ) {
    const h = [...hour.values][0];
    const m = [...minute.values][0];
    parts.push(`at ${pad(h)}:${pad(m)}`);
  } else {
    parts.push(describeField(minute, CRON_FIELDS[0]));
    if (hour.restricted)
      parts.push("past " + describeField(hour, CRON_FIELDS[1]));
  }

  if (dom.restricted) parts.push("on " + describeField(dom, CRON_FIELDS[2]));
  if (dow.restricted) parts.push("on " + describeField(dow, CRON_FIELDS[4]));
  if (month.restricted)
    parts.push("in " + describeField(month, CRON_FIELDS[3]));

  return parts.join(", ").replace(/^./, (c) => c.toUpperCase());
};

// ---------------------------------------------------------------------------
// Timezones.
// ---------------------------------------------------------------------------

const COMMON_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const allZones = (): string[] => {
  try {
    // Modern browsers expose the full IANA list here.
    const all = (Intl as any).supportedValuesOf?.("timeZone") as
      | string[]
      | undefined;
    if (all && all.length) return all;
  } catch {
    /* fall through */
  }
  return COMMON_ZONES;
};

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Format a Date in a target zone, plus that zone's short name / offset.
const formatInZone = (d: Date, zone: string): string => {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
    hour12: false,
  });
  return fmt.format(d);
};

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default (app: HTMLElement) => {
  disposeTime(); // drop any ticker from a previous visit

  const inputCls =
    "bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-200 font-mono";
  const labelCls = "text-green-700 font-mono text-xs uppercase tracking-widest";
  const cardCls =
    "bg-stone-900 border border-green-900 rounded p-4 flex flex-col gap-3";
  const btnCls =
    "border border-green-900 hover:border-green-600 text-green-300 font-bold px-4 py-2 rounded cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Time
    </h1>
  </a>
  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Timestamps, timezones, relative time, and cron — all in the browser,
    running in <span class="text-green-500">${esc(localZone)}</span>.
  </p>

  <div id="time-tabs" class="w-full max-w-3xl mt-6 flex flex-wrap gap-2 justify-center font-mono text-sm"></div>

  <div class="w-full max-w-3xl mt-6">
    <section data-panel="unix" class="flex-col gap-4 hidden">
      <div class="${cardCls}">
        <span class="${labelCls}">Unix timestamp → date</span>
        <div class="flex flex-wrap gap-2 items-center">
          <input id="u-ts" type="text" inputmode="numeric" placeholder="seconds or milliseconds" autocomplete="off"
            class="${inputCls} flex-1 min-w-40" />
          <button id="u-now" class="${btnCls}">Now</button>
        </div>
        <div id="u-ts-out" class="font-mono text-sm text-green-300 whitespace-pre-wrap wrap-break-word"></div>
      </div>

      <div class="${cardCls}">
        <span class="${labelCls}">Date → Unix timestamp</span>
        <input id="u-date" type="datetime-local" step="1" class="${inputCls}" />
        <div id="u-date-out" class="font-mono text-sm text-green-300 whitespace-pre-wrap wrap-break-word"></div>
      </div>
    </section>

    <section data-panel="tz" class="flex-col gap-4 hidden">
      <div class="${cardCls}">
        <span class="${labelCls}">Instant to convert</span>
        <div class="flex flex-wrap gap-2 items-center">
          <input id="tz-date" type="datetime-local" step="1" class="${inputCls}" />
          <select id="tz-source" class="${inputCls}"></select>
          <button id="tz-now" class="${btnCls}">Now</button>
        </div>
        <div class="flex flex-wrap gap-2 items-center">
          <span class="${labelCls}">Add zone</span>
          <select id="tz-add" class="${inputCls} flex-1 min-w-40"></select>
        </div>
      </div>
      <div id="tz-out" class="flex flex-col gap-2"></div>
    </section>

    <section data-panel="relative" class="flex-col gap-4 hidden">
      <div class="${cardCls}">
        <span class="${labelCls}">Target time</span>
        <div class="flex flex-wrap gap-2 items-center">
          <input id="rel-date" type="datetime-local" step="1" class="${inputCls} flex-1 min-w-40" />
          <button id="rel-now" class="${btnCls}">Now</button>
        </div>
        <div id="rel-out" class="text-3xl md:text-4xl font-bold text-green-300 font-mono"></div>
        <div id="rel-sub" class="font-mono text-sm text-green-700"></div>
      </div>
    </section>

    <section data-panel="cron" class="flex-col gap-4 hidden">
      <div class="${cardCls}">
        <span class="${labelCls}">Cron expression (minute hour day month weekday)</span>
        <div class="flex flex-wrap gap-2 items-center">
          <input id="cron-expr" type="text" spellcheck="false" autocomplete="off" placeholder="*/15 9-17 * * 1-5"
            class="${inputCls} flex-1 min-w-40" />
        </div>
        <div id="cron-desc" class="font-mono text-sm text-green-400"></div>
        <div id="cron-error" class="font-mono text-sm text-red-500"></div>
      </div>

      <div class="${cardCls}">
        <span class="${labelCls}">Builder</span>
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-3" id="cron-builder"></div>
        <p class="text-green-800 text-xs font-mono">
          Each box is a raw cron field — try <span class="text-green-500">*/5</span>,
          <span class="text-green-500">1-5</span>, or <span class="text-green-500">0,30</span>.
        </p>
      </div>

      <div class="${cardCls}">
        <span class="${labelCls}">Next runs (${esc(localZone)})</span>
        <div id="cron-next" class="font-mono text-sm text-green-300 flex flex-col gap-1"></div>
      </div>
    </section>
  </div>
</div>`;

  // --- tab switching -------------------------------------------------------
  const tabsEl = app.querySelector<HTMLDivElement>("#time-tabs")!;
  const panels = new Map<Tab, HTMLElement>();
  app
    .querySelectorAll<HTMLElement>("[data-panel]")
    .forEach((p) => panels.set(p.dataset.panel as Tab, p));

  const TAB_LABELS: [Tab, string][] = [
    ["unix", "Unix"],
    ["tz", "Timezones"],
    ["relative", "Relative"],
    ["cron", "Cron"],
  ];

  let active: Tab = "unix";
  const tabBtns = new Map<Tab, HTMLButtonElement>();

  const showTab = (tab: Tab) => {
    active = tab;
    for (const [t, panel] of panels) {
      const on = t === tab;
      panel.classList.toggle("hidden", !on);
      panel.classList.toggle("flex", on);
    }
    for (const [t, btn] of tabBtns) {
      const on = t === tab;
      btn.classList.toggle("border-green-500", on);
      btn.classList.toggle("text-green-300", on);
      btn.classList.toggle("border-green-900", !on);
      btn.classList.toggle("text-green-700", !on);
    }
  };

  for (const [tab, label] of TAB_LABELS) {
    const btn = document.createElement("button");
    btn.className =
      "border rounded px-4 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";
    btn.textContent = label;
    btn.onclick = () => showTab(tab);
    tabBtns.set(tab, btn);
    tabsEl.appendChild(btn);
  }

  // --- Unix ----------------------------------------------------------------
  const uTs = app.querySelector<HTMLInputElement>("#u-ts")!;
  const uTsOut = app.querySelector<HTMLDivElement>("#u-ts-out")!;
  const uDate = app.querySelector<HTMLInputElement>("#u-date")!;
  const uDateOut = app.querySelector<HTMLDivElement>("#u-date-out")!;

  const renderTsOut = () => {
    const raw = uTs.value.trim();
    if (!raw) {
      uTsOut.textContent = "";
      return;
    }
    if (!/^-?\d+$/.test(raw)) {
      uTsOut.innerHTML = `<span class="text-red-500">Enter a whole number.</span>`;
      return;
    }
    const num = parseInt(raw, 10);
    // Heuristic: 13+ digits → milliseconds, otherwise seconds.
    const ms = raw.replace("-", "").length >= 13 ? num : num * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) {
      uTsOut.innerHTML = `<span class="text-red-500">Out of range.</span>`;
      return;
    }
    const unit = raw.replace("-", "").length >= 13 ? "milliseconds" : "seconds";
    uTsOut.innerHTML = [
      `<span class="text-green-700">interpreted as</span> ${unit}`,
      `<span class="text-green-700">local  </span> ${esc(d.toLocaleString())}`,
      `<span class="text-green-700">UTC    </span> ${esc(d.toUTCString())}`,
      `<span class="text-green-700">ISO    </span> ${esc(d.toISOString())}`,
    ].join("\n");
    uTsOut.style.whiteSpace = "pre-wrap";
  };

  const renderDateOut = () => {
    if (!uDate.value) {
      uDateOut.textContent = "";
      return;
    }
    const d = new Date(uDate.value);
    if (isNaN(d.getTime())) {
      uDateOut.textContent = "";
      return;
    }
    const secs = Math.floor(d.getTime() / 1000);
    uDateOut.innerHTML = [
      `<span class="text-green-700">seconds     </span> ${secs}`,
      `<span class="text-green-700">milliseconds</span> ${d.getTime()}`,
      `<span class="text-green-700">ISO         </span> ${esc(d.toISOString())}`,
    ].join("\n");
    uDateOut.style.whiteSpace = "pre-wrap";
  };

  uTs.addEventListener("input", renderTsOut);
  uDate.addEventListener("input", renderDateOut);
  app.querySelector<HTMLButtonElement>("#u-now")!.onclick = () => {
    uTs.value = String(Math.floor(Date.now() / 1000));
    renderTsOut();
  };
  uDate.value = toLocalInput(new Date()) + ":00";
  renderDateOut();

  // --- Timezones -----------------------------------------------------------
  const tzDate = app.querySelector<HTMLInputElement>("#tz-date")!;
  const tzSource = app.querySelector<HTMLSelectElement>("#tz-source")!;
  const tzAdd = app.querySelector<HTMLSelectElement>("#tz-add")!;
  const tzOut = app.querySelector<HTMLDivElement>("#tz-out")!;

  const zones = allZones();
  const zoneOptions = zones
    .map((z) => `<option value="${esc(z)}">${esc(z)}</option>`)
    .join("");
  tzSource.innerHTML = zoneOptions;
  tzAdd.innerHTML =
    `<option value="">— pick a zone to add —</option>` + zoneOptions;
  tzSource.value = zones.includes(localZone) ? localZone : "UTC";

  // Zones currently displayed, in insertion order.
  const shownZones: string[] = [
    ...new Set([localZone, "UTC", ...COMMON_ZONES.slice(0, 4)]),
  ].filter((z) => zones.includes(z));

  // Interpret the datetime-local value AS the chosen source zone, returning
  // the true instant. We find the offset the source zone had at that wall
  // time by formatting a UTC guess and measuring the drift.
  const instantFromZonedInput = (value: string, zone: string): Date | null => {
    const m = value.match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+)(?::(\d+))?$/);
    if (!m) return null;
    const [, y, mo, da, h, mi, s] = m.map((x) => (x ? parseInt(x, 10) : 0));
    // Wall-clock as if it were UTC, then correct by the zone's offset.
    const asUtc = Date.UTC(y, mo - 1, da, h, mi, s || 0);
    const offset = zoneOffsetMs(new Date(asUtc), zone);
    return new Date(asUtc - offset);
  };

  // The offset (ms) of `zone` at the instant `d`, i.e. localTime - UTC.
  const zoneOffsetMs = (d: Date, zone: string): number => {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(d).map((p) => [p.type, p.value]),
    );
    const asIfUtc = Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour % 24,
      +parts.minute,
      +parts.second,
    );
    return asIfUtc - d.getTime();
  };

  const renderTz = () => {
    const instant = instantFromZonedInput(tzDate.value, tzSource.value);
    if (!instant) {
      tzOut.innerHTML = "";
      return;
    }
    tzOut.innerHTML = shownZones
      .map((z) => {
        const removable = shownZones.length > 1;
        return `
        <div class="bg-stone-900 border border-green-900 rounded px-4 py-3 flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-green-500 font-mono text-sm truncate">${esc(z)}</div>
            <div class="text-green-300 font-mono">${esc(formatInZone(instant, z))}</div>
          </div>
          ${
            removable
              ? `<button data-zone="${esc(z)}" class="text-green-800 hover:text-red-400 cursor-pointer font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950 rounded" aria-label="remove ${esc(z)}">×</button>`
              : ""
          }
        </div>`;
      })
      .join("");
    tzOut.querySelectorAll<HTMLButtonElement>("[data-zone]").forEach((b) => {
      b.onclick = () => {
        const i = shownZones.indexOf(b.dataset.zone!);
        if (i >= 0) shownZones.splice(i, 1);
        renderTz();
      };
    });
  };

  tzDate.addEventListener("input", renderTz);
  tzSource.addEventListener("change", renderTz);
  tzAdd.addEventListener("change", () => {
    const z = tzAdd.value;
    if (z && !shownZones.includes(z)) shownZones.push(z);
    tzAdd.value = "";
    renderTz();
  });
  app.querySelector<HTMLButtonElement>("#tz-now")!.onclick = () => {
    tzSource.value = zones.includes(localZone) ? localZone : "UTC";
    tzDate.value =
      toLocalInput(new Date()) + ":" + pad(new Date().getSeconds());
    renderTz();
  };
  tzDate.value = toLocalInput(new Date()) + ":00";
  renderTz();

  // --- Relative time -------------------------------------------------------
  const relDate = app.querySelector<HTMLInputElement>("#rel-date")!;
  const relOut = app.querySelector<HTMLDivElement>("#rel-out")!;
  const relSub = app.querySelector<HTMLDivElement>("#rel-sub")!;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000_000],
    ["month", 2592000_000],
    ["week", 604800_000],
    ["day", 86400_000],
    ["hour", 3600_000],
    ["minute", 60_000],
    ["second", 1000],
  ];

  const renderRelative = () => {
    if (!relDate.value) {
      relOut.textContent = "—";
      relSub.textContent = "";
      return;
    }
    const target = new Date(relDate.value);
    if (isNaN(target.getTime())) {
      relOut.textContent = "—";
      relSub.textContent = "";
      return;
    }
    const diff = target.getTime() - Date.now();
    const abs = Math.abs(diff);
    let phrase = "now";
    for (const [unit, ms] of RELATIVE_UNITS) {
      if (abs >= ms || unit === "second") {
        phrase = rtf.format(Math.round(diff / ms), unit);
        break;
      }
    }
    relOut.textContent = phrase;
    relSub.textContent = `${target.toLocaleString()} · ${
      diff >= 0 ? "+" : "−"
    }${Math.round(abs / 1000).toLocaleString()} s`;
  };

  relDate.addEventListener("input", renderRelative);
  app.querySelector<HTMLButtonElement>("#rel-now")!.onclick = () => {
    relDate.value =
      toLocalInput(new Date()) + ":" + pad(new Date().getSeconds());
    renderRelative();
  };
  relDate.value = toLocalInput(new Date(Date.now() + 3600_000)) + ":00";
  renderRelative();
  // Keep the relative view honest while it's on screen.
  const relTimer = window.setInterval(() => {
    if (active === "relative") renderRelative();
  }, 1000);
  teardown = () => clearInterval(relTimer);

  // --- Cron ----------------------------------------------------------------
  const cronExpr = app.querySelector<HTMLInputElement>("#cron-expr")!;
  const cronDesc = app.querySelector<HTMLDivElement>("#cron-desc")!;
  const cronError = app.querySelector<HTMLDivElement>("#cron-error")!;
  const cronNext = app.querySelector<HTMLDivElement>("#cron-next")!;
  const builderEl = app.querySelector<HTMLDivElement>("#cron-builder")!;

  const BUILDER_FIELDS = ["minute", "hour", "day", "month", "weekday"];
  const builderInputs: HTMLInputElement[] = BUILDER_FIELDS.map((name, i) => {
    const wrap = document.createElement("label");
    wrap.className = "flex flex-col gap-1";
    wrap.innerHTML = `<span class="text-green-700 text-xs font-mono">${name}</span>`;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.spellcheck = false;
    inp.autocomplete = "off";
    inp.value = "*";
    inp.className =
      "bg-stone-950 border border-green-900 focus:border-green-600 outline-none rounded px-2 py-1.5 text-green-200 font-mono text-center w-full";
    inp.addEventListener("input", () => {
      // Builder edits drive the expression, which drives everything else.
      // fromBuilder=true is required here: renderCron(false) would call
      // syncBuilder() and reassign every box's `.value` — including the one
      // being typed into — which resets its cursor to the end after every
      // keystroke.
      cronExpr.value = builderInputs
        .map((b) => b.value.trim() || "*")
        .join(" ");
      renderCron(true);
    });
    wrap.appendChild(inp);
    builderEl.appendChild(wrap);
    void i;
    return inp;
  });

  // Push the parsed expression back into the builder boxes.
  const syncBuilder = () => {
    const parts = cronExpr.value.trim().replace(/\s+/g, " ").split(" ");
    if (parts.length === 5) {
      builderInputs.forEach((b, i) => (b.value = parts[i]));
    }
  };

  // `fromBuilder` avoids clobbering the box the user is typing in.
  const renderCron = (fromBuilder: boolean) => {
    if (!fromBuilder) syncBuilder();
    let parsed: ParsedCron;
    try {
      parsed = parseCron(cronExpr.value);
    } catch (err) {
      cronError.textContent = err instanceof Error ? err.message : String(err);
      cronDesc.textContent = "";
      cronNext.innerHTML = `<span class="text-green-800">—</span>`;
      return;
    }
    cronError.textContent = "";
    cronDesc.textContent = describeCron(parsed);
    const runs = nextCronRuns(parsed, new Date(), 6);
    cronNext.innerHTML = runs.length
      ? runs
          .map((r) => {
            const rel = (() => {
              const diff = r.getTime() - Date.now();
              for (const [unit, ms] of RELATIVE_UNITS)
                if (Math.abs(diff) >= ms || unit === "second")
                  return rtf.format(Math.round(diff / ms), unit);
              return "";
            })();
            return `<div class="flex justify-between gap-3">
              <span>${esc(r.toLocaleString())}</span>
              <span class="text-green-700">${esc(rel)}</span>
            </div>`;
          })
          .join("")
      : `<span class="text-green-800">No upcoming runs found.</span>`;
  };

  cronExpr.addEventListener("input", () => renderCron(false));
  cronExpr.value = "*/15 9-17 * * 1-5";
  renderCron(false);

  showTab("unix");
};
