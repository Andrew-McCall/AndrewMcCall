import { $, $$ } from "./dom";
import { MODES } from "./layout";

export interface Desk {
  names(): string[];
  isOpen(app: string): boolean;
  show(app: string): void;
  close(app: string): void;
  closeAll(): void;
  only(app: string): void;
  focus(app: string): void;
  layout(mode?: string): string;
  toggleMax(): boolean;
  setHue(value: number): void;
  seed(next?: number | "new"): number;
  seedLink(): string;
  ready(app: string): Promise<void>;
}

interface TextFile {
  read(): string;
  href?: string;
}

interface Folder {
  [name: string]: TextFile | Folder;
}

interface Command {
  usage: string;
  about: string;
  run(args: string[]): void;
}

const owns = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const isFolder = (node: TextFile | Folder | undefined): node is Folder =>
  node !== undefined && typeof (node as TextFile).read !== "function";

const LIFE_BUTTONS: Record<string, string> = {
  play: "run",
  pause: "run",
  step: "step",
  random: "rand",
  clear: "clear",
};

export function mountTerminal(
  win: HTMLElement,
  tiles: HTMLElement,
  desk: Desk,
  wide: () => boolean,
  signal: AbortSignal,
): void {
  const log = $("#term-log", win);
  const input = $<HTMLInputElement>("#term-in", win);
  const prompt = $("#term-ps", win);
  const history: string[] = [];
  let historyAt = 0;
  let cwd: string[] = [];
  let skipFocus = false;
  let pointerDown = false;

  const windowOf = (app: string) => $(`.win[data-app="${app}"]`, tiles);

  const listFolder = (app: string): Folder => {
    const folder: Folder = {};
    for (const row of $$("li", $(".list", windowOf(app)))) {
      const link = $<HTMLAnchorElement>("a", row);
      const lines = [link.textContent ?? "", ...$$("span", row).map((s) => s.textContent ?? "")];
      folder[link.textContent ?? ""] = { read: () => lines.join("\n"), href: link.href || undefined };
    }
    return folder;
  };

  const table = (app: string): string =>
    $$("dt", $(".kv", windowOf(app)))
      .map((dt) => `${(dt.textContent ?? "").padEnd(11)}${dt.nextElementSibling?.textContent ?? ""}`)
      .join("\n");

  const files: Folder = {
    "about.txt": {
      read: () =>
        $$("p:not(.tag)", windowOf("about"))
          .map((p) => p.textContent ?? "")
          .join("\n"),
    },
    "now.txt": { read: () => table("now") },
    "stack.txt": { read: () => table("fetch") },
    "contact.txt": {
      read: () => $$("dd", windowOf("contact")).map((dd) => dd.firstElementChild?.textContent ?? "").join("\n"),
    },
    projects: listFolder("projects"),
    posts: listFolder("posts"),
  };

  const path = () => "~" + cwd.map((part) => "/" + part).join("");

  const walk = (arg: string | undefined) => {
    const parts = arg && /^[~/]/.test(arg) ? [] : [...cwd];
    for (const part of (arg ?? "").split("/")) {
      if (!part || part === "." || part === "~") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    let node: TextFile | Folder | undefined = files;
    for (const part of parts) {
      node = isFolder(node) && owns(node, part) ? node[part] : undefined;
      if (node === undefined) break;
    }
    return { node, parts };
  };

  const eachFile = (folder: Folder, prefix: string, visit: (name: string, file: TextFile) => void) => {
    for (const [name, node] of Object.entries(folder)) {
      if (isFolder(node)) eachFile(node, prefix + name + "/", visit);
      else visit(prefix + name, node);
    }
  };

  const out = (...parts: (string | Node)[]) => {
    const line = document.createElement("div");
    line.append(...parts);
    log.append(line);
  };

  const link = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    if (!href.startsWith(location.origin)) {
      a.target = "_blank";
      a.rel = "noopener";
    }
    a.textContent = href;
    return a;
  };

  const scrollDown = () => {
    log.scrollTop = log.scrollHeight;
  };

  const withWindow = (app: string | undefined, then: (app: string) => void) => {
    if (app && desk.names().includes(app)) then(app);
    else out(`no window called "${app ?? ""}". Windows: ${desk.names().join(" ")}`);
  };

  const stay = (app: string) => {
    if (app !== "term" && desk.isOpen("term")) {
      desk.focus("term");
      input.focus();
    }
  };

  const commands: Record<string, Command> = {
    help: {
      usage: "help [command]",
      about: "list commands, or explain one",
      run: ([name]) => {
        if (name && owns(commands, name)) {
          out(`${commands[name].usage}\n  ${commands[name].about}`);
          return;
        }
        const lines = Object.values(commands)
          .filter((c) => c.about)
          .map((c) => `${c.usage.padEnd(38)}${c.about}`);
        out(lines.join("\n"));
        out("Tab completes. Up arrow recalls. Ctrl+L clears. Chain with &&. Esc leaves the prompt.");
      },
    },
    ls: {
      usage: "ls [path]",
      about: "list files",
      run: ([target]) => {
        const { node } = walk(target);
        if (node === undefined) out(`ls: ${target}: no such file or directory`);
        else if (isFolder(node)) {
          out(
            Object.keys(node)
              .map((name) => (isFolder(node[name]) ? name + "/" : name))
              .join("  "),
          );
        } else out(target ?? "");
      },
    },
    cd: {
      usage: "cd [path]",
      about: "change directory",
      run: ([target]) => {
        const { node, parts } = walk(target ?? "~");
        if (isFolder(node)) cwd = parts;
        else out(`cd: ${target}: not a directory`);
      },
    },
    pwd: { usage: "pwd", about: "print the current directory", run: () => out(path()) },
    cat: {
      usage: "cat <file>",
      about: "read a file",
      run: (targets) => {
        if (!targets.length) return out("usage: cat <file>");
        for (const target of targets) {
          const { node } = walk(target);
          if (node === undefined) out(`cat: ${target}: no such file`);
          else if (isFolder(node)) out(`cat: ${target}: is a directory`);
          else {
            out(node.read());
            if (node.href) out(link(node.href));
          }
        }
      },
    },
    tree: {
      usage: "tree",
      about: "show every file",
      run: () => {
        const lines = ["~"];
        const draw = (folder: Folder, pad: string) => {
          const names = Object.keys(folder);
          names.forEach((name, i) => {
            const last = i === names.length - 1;
            const node = folder[name];
            lines.push(pad + (last ? "└─ " : "├─ ") + name + (isFolder(node) ? "/" : ""));
            if (isFolder(node)) draw(node, pad + (last ? "   " : "│  "));
          });
        };
        draw(files, "");
        out(lines.join("\n"));
      },
    },
    grep: {
      usage: "grep <text>",
      about: "search every file",
      run: (words) => {
        const query = words.join(" ").toLowerCase();
        if (!query) return out("usage: grep <text>");
        const hits: string[] = [];
        eachFile(files, "~/", (name, file) => {
          for (const line of file.read().split("\n")) {
            if (line.toLowerCase().includes(query)) hits.push(`${name}: ${line.trim()}`);
          }
        });
        out(hits.join("\n") || `no matches for "${query}"`);
      },
    },
    open: {
      usage: "open <window|file>",
      about: "open a window, or get a file's link",
      run: ([target]) => {
        const app = (target ?? "").replace(/\/$/, "");
        if (desk.names().includes(app)) {
          desk.show(app);
          stay(app);
          return out(`opened ${app}`);
        }
        const { node } = walk(target);
        if (node && !isFolder(node) && node.href) out(link(node.href));
        else out(`open: ${target ?? ""}: not a window, or a file with a link`);
      },
    },
    close: {
      usage: "close <window|all>",
      about: "close a window",
      run: ([target]) => {
        if (target === "all") return desk.closeAll();
        withWindow(target, (app) => {
          desk.close(app);
          stay(app);
          out(`closed ${app}`);
        });
      },
    },
    only: {
      usage: "only <window>",
      about: "close everything else",
      run: ([target]) => withWindow(target, (app) => desk.only(app)),
    },
    focus: {
      usage: "focus <window>",
      about: "jump to an open window",
      run: ([target]) =>
        withWindow(target, (app) => (desk.isOpen(app) ? desk.focus(app) : out(`${app} is not open`))),
    },
    windows: {
      usage: "windows",
      about: "list windows and which are open",
      run: () =>
        out(
          desk
            .names()
            .map((app) => `${desk.isOpen(app) ? "■" : "□"} ${app}`)
            .join("\n"),
        ),
    },
    layout: {
      usage: "layout [dwindle|grid]",
      about: "switch the tiling layout",
      run: ([mode]) => out(`layout: ${desk.layout(mode)}`),
    },
    max: {
      usage: "max",
      about: "maximise the focused window, or undo it",
      run: () => out(desk.toggleMax() ? "maximised" : "tiled"),
    },
    hue: {
      usage: "hue <0-360|random>",
      about: "turn every colour on the page",
      run: ([value]) => {
        const hue = value === "random" ? Math.random() * 360 : Number(value);
        if (value === undefined || !(hue >= 0 && hue <= 360)) return out("usage: hue <0-360|random>");
        desk.setHue(Math.round(hue));
        out(`hue ${Math.round(hue)}`);
      },
    },
    seed: {
      usage: "seed [value|new]",
      about: "show or set the seed every toy runs from",
      run: ([value]) => {
        if (value === "new") desk.seed("new");
        else if (value) {
          const parsed = parseInt(value, 36);
          if (!(parsed > 0)) return out("usage: seed [value|new]");
          desk.seed(parsed);
        }
        out(`seed ${desk.seed().toString(36)}`);
        out(link(desk.seedLink()));
      },
    },
    life: {
      usage: "life <play|pause|step|random|clear>",
      about: "drive the game of life",
      run: ([action]) => {
        const id = action && LIFE_BUTTONS[action];
        if (!id) return out("usage: life <play|pause|step|random|clear>");
        if (!desk.isOpen("life")) {
          desk.show("life");
          stay("life");
        }
        desk.ready("life").then(() => {
          const button = $<HTMLButtonElement>(`#life-${id}`, windowOf("life"));
          const wantsPlay = action === "play";
          if (id !== "run" || (button.textContent === "Play") === wantsPlay) button.click();
        });
        out(`life: ${action}`);
      },
    },
    fetch: {
      usage: "fetch",
      about: "print system info",
      run: () => out(`${$("h2", windowOf("fetch")).textContent}\n${table("fetch")}`),
    },
    whoami: { usage: "whoami", about: "who this is", run: () => out("Andrew McCall") },
    date: { usage: "date", about: "your local date and time", run: () => out(new Date().toString()) },
    echo: { usage: "echo <text>", about: "say it back", run: (words) => out(words.join(" ")) },
    history: {
      usage: "history",
      about: "commands typed so far",
      run: () => out(history.map((line, i) => `${String(i + 1).padStart(3)}  ${line}`).join("\n")),
    },
    clear: { usage: "clear", about: "clear the screen", run: () => log.replaceChildren() },
    exit: { usage: "exit", about: "close the terminal", run: () => desk.close("term") },
    sudo: {
      usage: "sudo",
      about: "",
      run: () => out("andrew is not in the sudoers file. This incident will be reported."),
    },
  };

  const completions: Record<string, string[]> = {
    seed: ["new"],
    life: Object.keys(LIFE_BUTTONS),
    layout: MODES,
    hue: ["random"],
    close: ["all"],
    help: Object.keys(commands),
  };
  const takesWindow = ["open", "close", "only", "focus"];

  const run = (line: string) => {
    for (const part of line.split("&&")) {
      const [word, ...args] = part.trim().split(/\s+/);
      if (!word) continue;
      const name = word.toLowerCase();
      if (!owns(commands, name)) {
        out(`command not found: ${word}. Try help.`);
        break;
      }
      commands[name].run(args);
    }
  };

  const complete = () => {
    const match = input.value.match(/^([\s\S]*?)(\S*)$/);
    if (!match) return;
    const [, head, word] = match;
    const segment = (input.value.split("&&").pop() ?? "").trimStart();
    const command = segment.split(/\s+/)[0];
    let pool: string[];
    if (!segment.includes(" ")) {
      pool = Object.keys(commands).filter((name) => commands[name].about);
    } else {
      const cut = word.lastIndexOf("/") + 1;
      const base = word.slice(0, cut);
      const folder = walk(base).node;
      pool = isFolder(folder)
        ? Object.keys(folder).map((name) => base + name + (isFolder(folder[name]) ? "/" : ""))
        : [];
      if (!cut) {
        pool.push(...(completions[command] ?? []));
        if (takesWindow.includes(command)) pool.push(...desk.names());
      }
    }
    const hits = [...new Set(pool)].filter((candidate) => candidate.startsWith(word));
    if (!hits.length) return;
    if (hits.length === 1) {
      input.value = head + hits[0] + (hits[0].endsWith("/") ? "" : " ");
      return;
    }
    let shared = word.length;
    while (hits[0][shared] && hits.every((hit) => hit[shared] === hits[0][shared])) shared++;
    input.value = head + hits[0].slice(0, shared);
    out(hits.join("  "));
    scrollDown();
  };

  $("#term-form", win).addEventListener("submit", (event) => {
    event.preventDefault();
    const line = input.value;
    const echo = document.createElement("b");
    echo.textContent = `andrew@portfolio:${path()}$ `;
    out(echo, line);
    if (line.trim()) history.push(line);
    historyAt = history.length;
    input.value = "";
    run(line);
    prompt.textContent = `andrew@portfolio:${path()}$`;
    scrollDown();
  });

  input.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (event.key === "Tab") {
      event.preventDefault();
      complete();
    } else if (event.key === "ArrowUp" && historyAt > 0) {
      event.preventDefault();
      input.value = history[--historyAt];
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      historyAt = Math.min(historyAt + 1, history.length);
      input.value = history[historyAt] ?? "";
    } else if (event.key === "Escape") {
      skipFocus = true;
      win.focus();
    } else if (event.ctrlKey && key === "l") {
      event.preventDefault();
      log.replaceChildren();
    } else if (event.ctrlKey && key === "c" && input.selectionStart === input.selectionEnd) {
      event.preventDefault();
      input.value = "";
    }
  });

  win.addEventListener("pointerdown", () => {
    pointerDown = true;
  });
  window.addEventListener("pointerup", () => (pointerDown = false), { signal });
  win.addEventListener("focus", () => {
    if (skipFocus || pointerDown || !wide()) {
      skipFocus = false;
      return;
    }
    input.focus({ preventScroll: true });
  });
  win.addEventListener("click", (event) => {
    const onControl = (event.target as Element).closest("a, button");
    if (getSelection()?.isCollapsed && !onControl) input.focus();
  });
  scrollDown();
}
