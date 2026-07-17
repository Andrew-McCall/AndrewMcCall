// Cron generator — a self-contained, dependency-free cron builder. It parses
// and validates an expression, explains it in plain English, previews the next
// fire times (in local time), and offers a field-by-field builder plus a set of
// clickable presets. Toggle "seconds" to switch between the classic 5-field
// cron and the 6-field form (Quartz / node-cron style) that leads with seconds.
// Everything is plain DOM — nothing is fetched or bundled.

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

// ---------------------------------------------------------------------------
// Cron engine.
// A field is  *  a  a-b  a-b/n  */n  or a comma list of those.
// The seconds field only exists in 6-field mode.
// ---------------------------------------------------------------------------

interface CronField {
  min: number;
  max: number;
  name: string;
  labels?: string[]; // for pretty-printing (months, weekdays)
  aliases?: Record<string, number>; // input aliases (JAN, MON, …)
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

const monthAliases: Record<string, number> = {};
MONTHS.forEach((m, i) => (monthAliases[m.slice(0, 3).toUpperCase()] = i + 1));
const dowAliases: Record<string, number> = {};
WEEKDAYS.forEach((d, i) => (dowAliases[d.slice(0, 3).toUpperCase()] = i));

const SECOND_FIELD: CronField = { min: 0, max: 59, name: "second" };
const BASE_FIELDS: CronField[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month", labels: MONTHS, aliases: monthAliases },
  { min: 0, max: 6, name: "day-of-week", labels: WEEKDAYS, aliases: dowAliases },
];

const fieldsFor = (seconds: boolean): CronField[] =>
  seconds ? [SECOND_FIELD, ...BASE_FIELDS] : BASE_FIELDS;

// Named shortcuts accepted in the parser (5-field form). In 6-field mode a
// leading "0 " (seconds) is prepended so they still expand correctly.
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
    if (!/^\d+$/.test(tok)) throw new Error(`invalid ${field.name} value "${tok}"`);
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
    }

    // day-of-week 7 is an accepted alias for Sunday (0).
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
  fields: ParsedField[]; // [second?] minute hour dom month dow
  seconds: boolean;
}

const parseCron = (input: string, seconds: boolean): ParsedCron => {
  let expr = input.trim().replace(/\s+/g, " ");
  if (expr in CRON_MACROS) {
    expr = CRON_MACROS[expr];
    if (seconds) expr = "0 " + expr;
  } else if (expr.startsWith("@")) {
    throw new Error(`unknown macro "${expr.split(" ")[0]}"`);
  }

  const defs = fieldsFor(seconds);
  const parts = expr.split(" ").filter((p) => p !== "");
  if (parts.length !== defs.length)
    throw new Error(
      `expected ${defs.length} fields, got ${parts.length} (${defs
        .map((f) => f.name.replace("day-of-", ""))
        .join(" ")})`,
    );

  const fields = parts.map((p, i) => parseField(p, defs[i]));
  return { fields, seconds };
};

// Does `date` satisfy the day-of-month / day-of-week rules? Cron quirk: if BOTH
// are restricted, a match on EITHER counts (OR); if only one is restricted, only
// that one applies.
const dayMatches = (date: Date, dom: ParsedField, dow: ParsedField): boolean => {
  const domOk = dom.values.has(date.getDate());
  const dowOk = dow.values.has(date.getDay());
  if (dom.restricted && dow.restricted) return domOk || dowOk;
  if (dom.restricted) return domOk;
  if (dow.restricted) return dowOk;
  return true;
};

// Compute the next `count` fire times at or after `from`, in local time.
const nextCronRuns = (cron: ParsedCron, from: Date, count: number): Date[] => {
  const off = cron.seconds ? 1 : 0;
  const second = cron.seconds ? cron.fields[0] : null;
  const minute = cron.fields[off];
  const hour = cron.fields[off + 1];
  const dom = cron.fields[off + 2];
  const month = cron.fields[off + 3];
  const dow = cron.fields[off + 4];

  const runs: Date[] = [];
  const d = new Date(from.getTime());
  d.setMilliseconds(0);
  // Advance one tick past `from` so we never return the current instant.
  if (cron.seconds) d.setSeconds(d.getSeconds() + 1);
  else d.setSeconds(0), d.setMinutes(d.getMinutes() + 1);

  let guard = 0;
  const GUARD_MAX = 2_000_000; // ample; bails on impossible expressions.
  while (runs.length < count && guard++ < GUARD_MAX) {
    if (!month.values.has(d.getMonth() + 1)) {
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
    if (second && !second.values.has(d.getSeconds())) {
      d.setSeconds(d.getSeconds() + 1, 0);
      continue;
    }
    runs.push(new Date(d.getTime()));
    if (cron.seconds) d.setSeconds(d.getSeconds() + 1);
    else d.setMinutes(d.getMinutes() + 1);
  }
  return runs;
};

// Render one field to English (e.g. "every 15 minutes", "9").
const describeField = (f: ParsedField, field: CronField): string => {
  const labelOf = (n: number) =>
    field.labels?.[field.name === "month" ? n - 1 : n] ?? String(n);

  // Detect a clean "*/n" step over the whole range.
  const sorted = [...f.values].sort((a, b) => a - b);
  if (sorted.length > 1 && sorted[0] === field.min && !field.labels) {
    const step = sorted[1] - sorted[0];
    const isEven = sorted.every((v, i) => v === field.min + i * step);
    const coversRange = sorted[sorted.length - 1] + step > field.max;
    if (isEven && coversRange && step > 1) return `every ${step} ${field.name}s`;
  }

  return sorted.map(labelOf).join(", ");
};

const describeCron = (cron: ParsedCron): string => {
  const off = cron.seconds ? 1 : 0;
  const second = cron.seconds ? cron.fields[0] : null;
  const minute = cron.fields[off];
  const hour = cron.fields[off + 1];
  const dom = cron.fields[off + 2];
  const month = cron.fields[off + 3];
  const dow = cron.fields[off + 4];
  const defs = fieldsFor(cron.seconds);

  const parts: string[] = [];

  const single = (f: ParsedField) => f.restricted && f.values.size === 1;
  const one = (f: ParsedField) => [...f.values][0];

  // Time-of-day.
  if (single(minute) && single(hour) && (!second || single(second))) {
    const t = `${pad(one(hour))}:${pad(one(minute))}` + (second ? `:${pad(one(second))}` : "");
    parts.push(`at ${t}`);
  } else {
    if (second && second.restricted)
      parts.push("at second " + describeField(second, SECOND_FIELD));
    parts.push(
      minute.restricted
        ? "at minute " + describeField(minute, defs[off])
        : "every minute",
    );
    if (hour.restricted) parts.push("past hour " + describeField(hour, defs[off + 1]));
  }

  if (dom.restricted) parts.push("on day-of-month " + describeField(dom, defs[off + 2]));
  if (dow.restricted) parts.push("on " + describeField(dow, defs[off + 4]));
  if (month.restricted) parts.push("in " + describeField(month, defs[off + 3]));

  return parts.join(", ").replace(/^./, (c) => c.toUpperCase());
};

// ---------------------------------------------------------------------------
// Presets. Each is stored in 5-field form; a leading "0 " (seconds) is added
// when the page is in 6-field mode.
// ---------------------------------------------------------------------------

const PRESETS: [string, string][] = [
  ["Every minute", "* * * * *"],
  ["Every 5 minutes", "*/5 * * * *"],
  ["Every 15 minutes", "*/15 * * * *"],
  ["Every 30 minutes", "*/30 * * * *"],
  ["Every hour", "0 * * * *"],
  ["Every day at midnight", "0 0 * * *"],
  ["Every day at 9am", "0 9 * * *"],
  ["Weekdays at 9am", "0 9 * * 1-5"],
  ["Every Monday at 9am", "0 9 * * 1"],
  ["Every Sunday midnight", "0 0 * * 0"],
  ["1st of month at midnight", "0 0 1 * *"],
  ["Every quarter (1st)", "0 0 1 1,4,7,10 *"],
  ["New Year midnight", "0 0 1 1 *"],
];

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default (app: HTMLElement) => {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000_000], ["month", 2592000_000], ["week", 604800_000],
    ["day", 86400_000], ["hour", 3600_000], ["minute", 60_000], ["second", 1000],
  ];
  const relative = (d: Date): string => {
    const diff = d.getTime() - Date.now();
    for (const [unit, ms] of RELATIVE_UNITS)
      if (Math.abs(diff) >= ms || unit === "second")
        return rtf.format(Math.round(diff / ms), unit);
    return "";
  };

  const inputCls =
    "bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-200 font-mono";
  const labelCls = "text-green-700 font-mono text-xs uppercase tracking-widest";
  const cardCls = "bg-stone-900 border border-green-900 p-4 flex flex-col gap-3";
  const btnCls =
    "border border-green-900 hover:border-green-600 text-green-300 font-bold px-4 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Cron
    </h1>
  </a>
  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Build, validate and explain a cron schedule — with a live preview of the
    next runs in <span class="text-green-500">${esc(localZone)}</span>.
  </p>

  <div class="w-full max-w-3xl mt-6 flex flex-col gap-4">
    <div class="${cardCls}">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <span class="${labelCls}">Cron expression</span>
        <label class="flex items-center gap-2 text-green-300 font-mono text-sm cursor-pointer select-none">
          <input id="cron-seconds" type="checkbox" class="accent-green-600" />
          include seconds (6 fields)
        </label>
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        <input id="cron-expr" type="text" spellcheck="false" autocomplete="off"
          class="${inputCls} flex-1 min-w-40 text-lg" />
        <button id="cron-copy" class="${btnCls}">Copy</button>
      </div>
      <div id="cron-desc" class="font-mono text-sm text-green-400"></div>
      <div id="cron-error" class="font-mono text-sm text-red-500"></div>
    </div>

    <div class="${cardCls}">
      <span class="${labelCls}">Builder</span>
      <div class="grid grid-cols-3 sm:grid-cols-6 gap-3" id="cron-builder"></div>
      <p class="text-green-800 text-xs font-mono leading-relaxed">
        Each box is one field. Use
        <span class="text-green-500">*</span> (any),
        <span class="text-green-500">5</span> (exact),
        <span class="text-green-500">1-5</span> (range),
        <span class="text-green-500">*/15</span> (step),
        <span class="text-green-500">0,30</span> (list).
        Names like <span class="text-green-500">MON</span> or
        <span class="text-green-500">JAN</span> work too.
      </p>
    </div>

    <div class="${cardCls}">
      <span class="${labelCls}">Presets</span>
      <div id="cron-presets" class="flex flex-wrap gap-2"></div>
    </div>

    <div class="${cardCls}">
      <span class="${labelCls}">Next runs (${esc(localZone)})</span>
      <div id="cron-next" class="font-mono text-sm text-green-300 flex flex-col gap-1"></div>
    </div>
  </div>
</div>`;

  const secondsToggle = app.querySelector<HTMLInputElement>("#cron-seconds")!;
  const cronExpr = app.querySelector<HTMLInputElement>("#cron-expr")!;
  const cronCopy = app.querySelector<HTMLButtonElement>("#cron-copy")!;
  const cronDesc = app.querySelector<HTMLDivElement>("#cron-desc")!;
  const cronError = app.querySelector<HTMLDivElement>("#cron-error")!;
  const cronNext = app.querySelector<HTMLDivElement>("#cron-next")!;
  const builderEl = app.querySelector<HTMLDivElement>("#cron-builder")!;
  const presetsEl = app.querySelector<HTMLDivElement>("#cron-presets")!;

  const builderInputs: HTMLInputElement[] = [];

  const seconds = () => secondsToggle.checked;

  // (Re)build the field boxes for the current mode.
  const buildBoxes = () => {
    builderEl.innerHTML = "";
    builderInputs.length = 0;
    const defs = fieldsFor(seconds());
    const labels = defs.map((f) => f.name.replace("day-of-", ""));
    labels.forEach((name, i) => {
      const def = defs[i];
      const wrap = document.createElement("label");
      wrap.className = "flex flex-col gap-1";
      wrap.innerHTML = `<span class="text-green-700 text-xs font-mono truncate" title="${esc(name)} (${def.min}-${def.max})">${esc(name)}</span>`;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.spellcheck = false;
      inp.autocomplete = "off";
      inp.value = "*";
      inp.title = `${name} — allowed ${def.min}-${def.max}`;
      inp.className =
        "bg-stone-950 border border-green-900 focus:border-green-600 outline-none px-2 py-1.5 text-green-200 font-mono text-center w-full";
      inp.addEventListener("input", () => {
        cronExpr.value = builderInputs.map((b) => b.value.trim() || "*").join(" ");
        renderCron(true);
      });
      wrap.appendChild(inp);
      builderEl.appendChild(wrap);
      builderInputs.push(inp);
    });
  };

  // Push the current expression back into the builder boxes when it parses to
  // the right field count.
  const syncBuilder = () => {
    const parts = cronExpr.value.trim().replace(/\s+/g, " ").split(" ");
    if (parts.length === builderInputs.length)
      builderInputs.forEach((b, i) => (b.value = parts[i]));
  };

  // `fromBuilder` avoids clobbering the box the user is typing in.
  const renderCron = (fromBuilder: boolean) => {
    if (!fromBuilder) syncBuilder();
    let parsed: ParsedCron;
    try {
      parsed = parseCron(cronExpr.value, seconds());
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
          .map(
            (r) => `<div class="flex justify-between gap-3">
              <span>${esc(r.toLocaleString())}</span>
              <span class="text-green-700">${esc(relative(r))}</span>
            </div>`,
          )
          .join("")
      : `<span class="text-green-800">No upcoming runs found (impossible schedule?).</span>`;
  };

  // Presets — filled with a leading seconds field when in 6-field mode.
  const renderPresets = () => {
    presetsEl.innerHTML = "";
    for (const [label, base] of PRESETS) {
      const expr = seconds() ? "0 " + base : base;
      const btn = document.createElement("button");
      btn.className =
        "border border-green-900 hover:border-green-600 text-green-400 hover:text-green-200 font-mono text-xs px-3 py-1.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";
      btn.textContent = label;
      btn.title = expr;
      btn.onclick = () => {
        cronExpr.value = expr;
        renderCron(false);
      };
      presetsEl.appendChild(btn);
    }
  };

  cronExpr.addEventListener("input", () => renderCron(false));

  // A pending revert timeout captured `prev` label text at click time; a
  // second click before it fired would capture "Copied!" as `prev`, so the
  // first timeout later reset the button back to "Copied!" forever instead of
  // "Copy". Always reverting to the literal default, and cancelling any
  // pending timer first, keeps rapid clicks from desyncing the label.
  let copyResetTimer: number | undefined;
  cronCopy.addEventListener("click", async () => {
    if (copyResetTimer) window.clearTimeout(copyResetTimer);
    try {
      await navigator.clipboard.writeText(cronExpr.value);
      cronCopy.textContent = "Copied!";
    } catch {
      cronCopy.textContent = "Failed";
    }
    copyResetTimer = window.setTimeout(() => (cronCopy.textContent = "Copy"), 1200);
  });

  // Switching modes rebuilds the boxes and re-frames the current expression:
  // add or drop the leading seconds field so the meaning is preserved.
  secondsToggle.addEventListener("change", () => {
    const parts = cronExpr.value.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
    if (seconds() && parts.length === 5) cronExpr.value = "0 " + parts.join(" ");
    else if (!seconds() && parts.length === 6) cronExpr.value = parts.slice(1).join(" ");
    buildBoxes();
    renderPresets();
    renderCron(false);
  });

  buildBoxes();
  renderPresets();
  cronExpr.value = "*/15 9-17 * * 1-5";
  renderCron(false);
  cronExpr.focus();
};
