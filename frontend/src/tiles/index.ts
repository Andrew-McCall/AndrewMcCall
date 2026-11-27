import "@fontsource/darker-grotesque/latin-600.css";
import "@fontsource/darker-grotesque/latin-800.css";
import "@fontsource/darker-grotesque/latin-900.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-500-italic.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./tiles.css";

import type { Home } from "@andrewmccall/api-types";
import { api, jsonInit, setMeta, SITE_DESCRIPTION, SITE_TITLE } from "../helpers";
import { $, $$ } from "./dom";
import { MODES, neighbour, swapped, tile, windowLimit, type Mode, type Rect } from "./layout";
import { shell } from "./markup";
import { mountTerminal } from "./terminal";
import type { ToyHost } from "./toy";
import { START_OPEN, WINDOWS, type WinDef } from "./windows";

const STORE = "am-tiles";
const GAP = 6;
const GITHUB_SINCE = new Date(2021, 3, 27);
const LOGO = [".###. #...#", "#...# ##.##", "##### #.#.#", "#...# #...#", "#...# #...#"];

interface Saved {
  open: string[];
  focus?: string;
  mode: Mode;
  hue: number;
  plain: boolean;
}

let page: AbortController | null = null;

export const disposeTiles = (): void => {
  page?.abort();
  page = null;
};

const loadHome = async (): Promise<Home | null> => {
  try {
    const res = await api("/home", { signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as Home) : null;
  } catch {
    return null;
  }
};

export default async function tiles(app: HTMLElement): Promise<void> {
  disposeTiles();
  const controller = new AbortController();
  page = controller;
  const home = await loadHome();
  if (controller.signal.aborted) return;
  setMeta(home?.profile.seo_title || SITE_TITLE, home?.profile.seo_description || SITE_DESCRIPTION);
  app.innerHTML = `<div class="tiles">${shell(home)}</div>`;
  start($(".tiles", app), controller.signal);
}

function start(root: HTMLElement, signal: AbortSignal): void {
  const desk = $("#desk", root);
  const wide = matchMedia("(min-width: 768px)");
  const hovers = matchMedia("(hover: hover)");
  const params = new URLSearchParams(location.search);
  const defs = new Map<string, WinDef>(WINDOWS.map((def) => [def.app, def]));
  const wins: Record<string, HTMLElement> = {};
  for (const def of WINDOWS) wins[def.app] = $(`.win[data-app="${def.app}"]`, root);
  const toys = WINDOWS.filter((def) => def.toy).map((def) => def.app);
  const isToy = (app: string | undefined) => app !== undefined && toys.includes(app);
  const inPlainView = (app: string) => !isToy(app) && app !== "term";

  let open = [...START_OPEN];
  let focus: string | undefined = open[0];
  let mode: Mode = "dwindle";
  let hue = 0;
  let plain = params.has("static");
  let max = false;
  let rects: Record<string, Rect> = {};
  let recent: string[] = [];

  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Saved> | null;
    if (saved && Array.isArray(saved.open)) {
      open = saved.open.filter((app) => defs.has(app));
      focus = saved.focus && defs.has(saved.focus) ? saved.focus : open[0];
      if (saved.mode && MODES.includes(saved.mode)) mode = saved.mode;
      hue = Number(saved.hue) || 0;
      plain = plain || Boolean(saved.plain);
    }
  } catch {
    open = [...START_OPEN];
  }

  const save = () => {
    try {
      const state: Saved = { open, focus, mode, hue, plain };
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch {
      return;
    }
  };

  const every = (ms: number, tick: () => void) => {
    const id = setInterval(tick, ms);
    const stop = () => clearInterval(id);
    signal.addEventListener("abort", stop);
    return stop;
  };
  const later = (ms: number, run: () => void) => {
    setTimeout(() => {
      if (!signal.aborted) run();
    }, ms);
  };

  const freshSeed = () => 1 + Math.floor(Math.random() * 0xfffffe);
  const linkedSeed = parseInt(params.get("seed") ?? "", 36);
  let seed = linkedSeed > 0 ? linkedSeed : freshSeed();
  const seedUsers: ((seed: number) => void)[] = [];
  const setSeed = (next: number) => {
    seed = next;
    for (const use of seedUsers) use(seed);
  };
  const seedLink = () => {
    const toy = isToy(focus) ? `&toy=${focus}` : "";
    return `${location.origin}${location.pathname}?seed=${seed.toString(36)}${toy}`;
  };
  const linkedToy = params.get("toy") ?? undefined;
  if (isToy(linkedToy)) {
    if (!open.includes(linkedToy!)) open.push(linkedToy!);
    focus = linkedToy;
    plain = false;
  }

  const started = new Map<string, Promise<void>>();
  const hostFor = (app: string): ToyHost => {
    const win = wins[app];
    const body = $(".win-body", win);
    return {
      win,
      body,
      signal,
      wide: () => wide.matches,
      visible: () => !win.hidden && !document.hidden,
      onSeed(use) {
        seedUsers.push(use);
        body.querySelector("[data-restart]")?.addEventListener("click", () => use(seed));
        use(seed);
      },
      frame(tick) {
        const loop = (time: number) => {
          if (signal.aborted) return;
          if (!win.hidden && !document.hidden) tick(time);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      },
      every,
      later,
    };
  };
  const ensure = (app: string): Promise<void> => {
    const load = defs.get(app)?.toy;
    if (!load) return Promise.resolve();
    let ready = started.get(app);
    if (!ready) {
      ready = load().then((module) => {
        if (!signal.aborted) module.default(hostFor(app));
      });
      started.set(app, ready);
    }
    return ready;
  };

  const apps = $("#apps", root);
  const menu = $("#toys-menu", root);
  const chips: Record<string, HTMLButtonElement> = {};
  const toysChip = document.createElement("button");
  let menuLeave = 0;

  const closeMenu = () => {
    menu.hidden = true;
    toysChip.setAttribute("aria-expanded", "false");
  };
  const openMenu = () => {
    clearTimeout(menuLeave);
    menu.hidden = false;
    toysChip.setAttribute("aria-expanded", "true");
    const box = toysChip.getBoundingClientRect();
    menu.style.top = `${box.bottom}px`;
    menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - menu.offsetWidth - 8))}px`;
  };

  for (const def of WINDOWS) {
    const chip = document.createElement("button");
    chip.className = "app";
    chip.type = "button";
    chip.dataset.app = def.app;
    chip.style.setProperty("--w", `var(--w-${def.app})`);
    chip.append(def.app, " ", Object.assign(document.createElement("kbd"), { textContent: def.key }));
    chip.addEventListener("click", () => {
      toggle(def.app);
      closeMenu();
    });
    chips[def.app] = chip;
    if (!def.toy) apps.append(chip);
    else menu.append(chip);
  }
  toysChip.className = "app";
  toysChip.type = "button";
  toysChip.id = "toys-btn";
  toysChip.setAttribute("aria-haspopup", "menu");
  toysChip.style.setProperty("--w", "var(--w-life)");
  toysChip.textContent = "toys ▾";
  apps.append(toysChip);
  closeMenu();

  // With no hover (touch) a tap has to open the list, or a single toy could never be picked.
  for (const el of [toysChip, menu]) {
    el.addEventListener("mouseenter", () => {
      if (hovers.matches) openMenu();
    });
    el.addEventListener("mouseleave", () => {
      clearTimeout(menuLeave);
      menuLeave = window.setTimeout(closeMenu, 220);
    });
  }
  toysChip.addEventListener("click", () => {
    if (!hovers.matches) {
      if (menu.hidden) openMenu();
      else closeMenu();
      return;
    }
    const openToys = toys.filter((app) => open.includes(app));
    if (openToys.length) openToys.forEach(close);
    else toggle(toys[Math.floor(Math.random() * toys.length)]);
  });
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!(event.target as Element).closest("#toys-menu, #toys-btn")) closeMenu();
    },
    { signal },
  );
  window.addEventListener("resize", closeMenu, { signal });
  apps.addEventListener("scroll", closeMenu);

  function clearPlacement(win: HTMLElement): void {
    win.style.left = win.style.top = win.style.width = win.style.height = "";
  }

  function renderPlain(): void {
    for (const def of WINDOWS) {
      const win = wins[def.app];
      clearPlacement(win);
      win.hidden = !inPlainView(def.app);
      win.classList.remove("focus");
      chips[def.app].setAttribute("aria-pressed", "false");
    }
    $("#empty", root).hidden = true;
    toysChip.setAttribute("aria-pressed", "false");
  }

  function trimToLimit(limit: number): void {
    while (open.length > limit) {
      const oldest = recent.find((app) => app !== focus && open.includes(app));
      const drop = oldest ?? open.find((app) => app !== focus);
      if (!drop) return;
      open.splice(open.indexOf(drop), 1);
    }
  }

  function render(): void {
    root.toggleAttribute("data-plain", plain);
    const single = !wide.matches;
    $("#layout", root).textContent = plain ? "static" : single ? "tiles" : mode;
    if (plain) return renderPlain();

    const limit = windowLimit(innerWidth);
    if (!recent.length) recent = [...open];
    if (focus && recent[recent.length - 1] !== focus) {
      recent = recent.filter((app) => app !== focus);
      recent.push(focus);
    }
    trimToLimit(limit);
    if (!focus || !open.includes(focus)) focus = open[0];
    const zoomed = (max || single) && focus !== undefined;
    const shown = zoomed && focus ? [focus] : open;

    for (const def of WINDOWS) {
      const win = wins[def.app];
      const isOpen = open.includes(def.app);
      win.hidden = !shown.includes(def.app);
      win.classList.toggle("focus", def.app === focus);
      chips[def.app].setAttribute("aria-pressed", String(single ? def.app === focus : isOpen));
      if (!win.hidden) void ensure(def.app);
    }
    $("#empty", root).hidden = open.length > 0;
    const toyShown = toys.some((app) => (single ? app === focus : open.includes(app)));
    toysChip.setAttribute("aria-pressed", String(toyShown));
    const count = limit === Infinity ? `${open.length}` : `${open.length}/${limit}`;
    $("#status", root).textContent = focus
      ? `${focus} · ${count} open · ${max && !single ? "max" : mode}`
      : "nothing open";
    $("#close-all", root).hidden = open.length <= 4;

    const before = rects;
    rects = {};
    if (single) {
      for (const def of WINDOWS) clearPlacement(wins[def.app]);
      return;
    }
    const placed = tile(shown.length, desk.clientWidth, desk.clientHeight, mode);
    shown.forEach((app, i) => {
      const [x, y, width, height] = placed[i];
      const win = wins[app];
      rects[app] = placed[i];
      const place = () => {
        win.style.left = `${x + GAP / 2}px`;
        win.style.top = `${y + GAP / 2}px`;
        win.style.width = `${width - GAP}px`;
        win.style.height = `${height - GAP}px`;
      };
      if (before[app]) return place();
      win.style.transition = "none";
      place();
      void win.offsetWidth;
      win.style.transition = "";
    });
  }

  function setFocus(app: string | undefined, moveFocus = false): void {
    focus = app;
    render();
    save();
    if (moveFocus && app) wins[app].focus({ preventScroll: wide.matches });
  }

  function toggle(app: string): void {
    if (plain && inPlainView(app)) {
      wins[app].scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    plain = false;
    chips[app].scrollIntoView({ inline: "nearest", block: "nearest" });
    if (!wide.matches && open.includes(app)) return setFocus(app, true);
    if (open.includes(app)) return close(app);
    const at = focus ? open.indexOf(focus) : -1;
    open.splice(at < 0 ? open.length : at + 1, 0, app);
    const win = wins[app];
    win.classList.remove("pop");
    void win.offsetWidth;
    win.classList.add("pop");
    setFocus(app, true);
  }

  function close(app: string): void {
    const at = open.indexOf(app);
    if (at < 0) return;
    open.splice(at, 1);
    if (app === focus) return setFocus(open[Math.min(at, open.length - 1)], true);
    render();
    save();
  }

  function closeAll(): void {
    open = [];
    max = false;
    setFocus(undefined);
  }

  function swap(by: number): void {
    const at = focus ? open.indexOf(focus) : -1;
    const other = at + by;
    if (at < 0 || other < 0 || other >= open.length) return;
    [open[at], open[other]] = [open[other], open[at]];
    render();
    save();
  }

  function cycleLayout(): void {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    render();
    save();
  }

  function cycleView(): void {
    const lastMode = mode === MODES[MODES.length - 1];
    if (plain) {
      plain = false;
      if (wide.matches) mode = MODES[0];
    } else if (lastMode || !wide.matches) {
      plain = true;
    } else {
      mode = MODES[MODES.indexOf(mode) + 1];
    }
    render();
    save();
  }

  function toggleMax(): void {
    max = !max;
    render();
  }

  function dragToSwap(app: string, bar: HTMLElement): void {
    const win = wins[app];
    bar.addEventListener("pointerdown", (down) => {
      const onClose = (down.target as Element).closest(".win-x");
      if (!wide.matches || max || plain || down.button !== 0 || onClose) return;
      const drag = new AbortController();
      let moving = false;
      let over: string | undefined;

      const move = (event: PointerEvent) => {
        const dx = event.clientX - down.clientX;
        const dy = event.clientY - down.clientY;
        if (!moving) {
          if (Math.hypot(dx, dy) < 6) return;
          moving = true;
          win.classList.add("drag");
          document.body.style.userSelect = "none";
        }
        win.style.transform = `translate(${dx}px, ${dy}px)`;
        const box = desk.getBoundingClientRect();
        const px = event.clientX - box.left;
        const py = event.clientY - box.top;
        const hit = open.find((other) => {
          const rect = rects[other];
          const inside =
            rect && px >= rect[0] && px < rect[0] + rect[2] && py >= rect[1] && py < rect[1] + rect[3];
          return other !== app && inside;
        });
        if (hit === over) return;
        if (over) wins[over].classList.remove("drop");
        over = hit;
        if (over) wins[over].classList.add("drop");
      };
      const drop = () => {
        drag.abort();
        if (!moving) return;
        win.classList.remove("drag");
        win.style.transform = "";
        document.body.style.userSelect = "";
        if (over) {
          wins[over].classList.remove("drop");
          open = swapped(open, app, over);
        }
        render();
        save();
      };
      window.addEventListener("pointermove", move, { signal: drag.signal });
      window.addEventListener("pointerup", drop, { signal: drag.signal });
      window.addEventListener("pointercancel", drop, { signal: drag.signal });
      signal.addEventListener("abort", () => drag.abort(), { signal: drag.signal });
    });
  }

  for (const def of WINDOWS) {
    const win = wins[def.app];
    const bar = $(".win-bar", win);
    const takeFocus = () => {
      if (focus === def.app || plain) return;
      focus = def.app;
      render();
      save();
    };
    win.addEventListener("pointerdown", takeFocus);
    win.addEventListener("focusin", takeFocus);
    $(".win-x", win).addEventListener("click", (event) => {
      event.stopPropagation();
      close(def.app);
    });
    bar.addEventListener("dblclick", toggleMax);
    dragToSwap(def.app, bar);
  }

  $("#layout", root).addEventListener("click", cycleView);
  $("#close-all", root).addEventListener("click", closeAll);

  const hueInput = $<HTMLInputElement>("#hue", root);
  const showHue = () => {
    hueInput.value = String(hue);
    root.style.setProperty("--hue", String(hue));
  };
  const setHue = (value: number) => {
    hue = value;
    showHue();
    save();
  };
  hueInput.addEventListener("input", () => setHue(Number(hueInput.value)));
  hueInput.addEventListener("change", () => hueInput.blur());
  showHue();

  const DIRECTIONS: Record<string, [number, number]> = {
    h: [-1, 0],
    l: [1, 0],
    k: [0, -1],
    j: [0, 1],
    arrowleft: [-1, 0],
    arrowright: [1, 0],
    arrowup: [0, -1],
    arrowdown: [0, 1],
  };
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || plain) return;
      const target = event.target;
      if (!(target instanceof Element) || target.matches("input, textarea, select")) return;
      const key = event.key.toLowerCase();
      if (event.key === "Escape") return closeMenu();
      if (key === " ") {
        if (target.matches("button, a")) return;
        event.preventDefault();
        return cycleLayout();
      }
      if (event.shiftKey && (key === "h" || key === "k")) return swap(-1);
      if (event.shiftKey && (key === "l" || key === "j")) return swap(1);
      const direction = DIRECTIONS[key];
      if (direction) {
        if (!wide.matches || !focus) return;
        event.preventDefault();
        const next = neighbour(rects, focus, direction[0], direction[1]);
        if (next) setFocus(next, true);
        return;
      }
      if (key === "q" && focus) {
        event.preventDefault();
        return close(focus);
      }
      if (key === "m") return toggleMax();
      const def = WINDOWS.find((candidate) => candidate.key === key);
      if (def) {
        event.preventDefault();
        toggle(def.app);
      }
    },
    { signal },
  );

  root.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    const plainClick = !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0;
    if (!link || link.target || link.origin !== location.origin || !plainClick) return;
    event.preventDefault();
    window.navigate(link.pathname + link.search);
  });

  const aboutText = document.createTreeWalker($(".win-body", wins.about), NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (aboutText.nextNode()) textNodes.push(aboutText.currentNode as Text);
  for (const text of textNodes) {
    const match = /\bnerdy?\b/i.exec(text.data);
    if (!match) continue;
    const word = text.splitText(match.index);
    word.splitText(match[0].length);
    const secret = document.createElement("span");
    word.replaceWith(secret);
    secret.append(word);
    secret.addEventListener("click", () => window.navigate("/secret"));
  }

  $("#logo", root).innerHTML = LOGO.join("")
    .replace(/./g, (pixel) => `<i${pixel === "#" ? ' class="on"' : ""}></i>`);
  const now = new Date();
  const behind = now.getDate() < GITHUB_SINCE.getDate() ? 1 : 0;
  const months =
    (now.getFullYear() - GITHUB_SINCE.getFullYear()) * 12 +
    now.getMonth() -
    GITHUB_SINCE.getMonth() -
    behind;
  $("#uptime", root).textContent = `${Math.floor(months / 12)}y ${months % 12}m on GitHub`;

  const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const tickClock = () => {
    const time = clock.format(new Date());
    for (const el of $$("[data-clock]", root)) el.textContent = time;
  };
  tickClock();
  every(1000, tickClock);
  const place = (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "").split("/").pop() ?? "";
  const zone = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value;
  $("#zone", root).textContent = [place.replace(/_/g, " "), zone].filter(Boolean).join(" · ");

  const drifting = Array.from({ length: 22 }, () => {
    const size = 3 + Math.floor(Math.random() * 14);
    const vars = [
      `left:${(Math.random() * 100).toFixed(1)}%`,
      `top:${(Math.random() * 100).toFixed(1)}%`,
      `width:${size}px`,
      `height:${size}px`,
      `--d:${(16 + Math.random() * 26).toFixed(1)}s`,
      `--t:${(-Math.random() * 30).toFixed(1)}s`,
      `--x:${Math.round((Math.random() - 0.5) * 220)}px`,
      `--y:${Math.round((Math.random() - 0.5) * 180)}px`,
      `--r:${Math.round((Math.random() - 0.5) * 240)}deg`,
    ];
    return `<i style="${vars.join(";")}"></i>`;
  });
  $("#void", root).innerHTML = drifting.join("");

  const flashLabel = (button: HTMLElement, text: string, rest: string) => {
    button.textContent = text;
    later(2200, () => (button.textContent = rest));
  };
  const copyButton = root.querySelector<HTMLElement>("#copy-email");
  copyButton?.addEventListener("click", async () => {
    const email = $("#email", root);
    try {
      await navigator.clipboard.writeText(email.textContent ?? "");
      flashLabel(copyButton, "Copied", "Copy");
    } catch {
      const range = document.createRange();
      range.selectNodeContents(email);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      flashLabel(copyButton, "Selected, press Ctrl+C", "Copy");
    }
  });

  $("#msg-form", root).addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $<HTMLTextAreaElement>("#msg-text", root);
    const from = $<HTMLInputElement>("#msg-from", root);
    const status = $("#msg-status", root);
    const send = $<HTMLButtonElement>("#msg-send", root);
    if (!text.value.trim()) {
      status.textContent = "Write something first.";
      return;
    }
    send.disabled = true;
    send.textContent = "Sending";
    try {
      const res = await api("/message", jsonInit({ text: text.value.trim(), from: from.value.trim() }));
      if (!res.ok) throw new Error(String(res.status));
      status.textContent = "Sent.";
      text.value = "";
    } catch (failure) {
      const limited = failure instanceof Error && failure.message === "429";
      status.textContent = limited
        ? "That is enough for now. Try again in an hour."
        : "Not sent. Try again in a minute.";
    }
    send.disabled = false;
    send.textContent = "Send";
  });

  mountTerminal(
    wins.term,
    root,
    {
      names: () => WINDOWS.map((def) => def.app),
      toys: () => toys,
      isOpen: (app) => open.includes(app),
      show: (app) => (open.includes(app) ? setFocus(app) : toggle(app)),
      close,
      closeAll,
      only(app) {
        open = [app];
        setFocus(app, true);
      },
      focus: (app) => setFocus(app, true),
      layout(next) {
        if (next === "static") {
          plain = true;
          render();
          save();
          return next;
        }
        const wanted = MODES.find((candidate) => candidate === next);
        plain = false;
        if (wanted) {
          mode = wanted;
          render();
          save();
        } else cycleLayout();
        return mode;
      },
      toggleMax() {
        toggleMax();
        return max;
      },
      setHue,
      seed(next) {
        if (next === "new") setSeed(freshSeed());
        else if (next !== undefined) setSeed(next);
        return seed;
      },
      seedLink,
      ready: ensure,
      showsOne: () => max || !wide.matches,
    },
    () => wide.matches,
    signal,
  );

  const resize = new ResizeObserver(render);
  resize.observe(desk);
  signal.addEventListener("abort", () => resize.disconnect());
  wide.addEventListener("change", render, { signal });
  render();

  const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 150));
  const queue = [...toys];
  const preload = () => {
    const app = queue.shift();
    if (!app || signal.aborted) return;
    void ensure(app).then(() => idle(preload));
  };
  if (document.readyState === "complete") idle(preload);
  else window.addEventListener("load", () => idle(preload), { signal });
}
