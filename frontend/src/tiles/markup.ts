import type { Home } from "@andrewmccall/api-types";
import { bareUrl, esc, fmtDate, SITE_DESCRIPTION } from "../helpers";
import { renderMarkdown } from "../markdown";
import { WINDOWS, type WinDef } from "./windows";

const detail = (home: Home | null, key: string) => home?.details.find((d) => d.key === key);

const aboutBody = (home: Home | null): string => {
  const based = detail(home, "based_in")?.value;
  const intro = home?.profile.intro_markdown ?? "";
  return `
    <span class="tag">Software engineer${based ? ` · ${esc(based)}` : ""}</span>
    <div class="stack">
      <h1>Andrew McCall</h1>
      <p class="lede">${esc(home?.profile.seo_description || SITE_DESCRIPTION)}</p>
      ${renderMarkdown(intro)}
    </div>
    <p class="tag" id="wm-hint">This whole page is a window manager. Open, close and rearrange it.</p>`;
};

export const plainText = (markdown: string): string =>
  markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|>)\s+/gm, "")
    .replace(/(^|[\s(])(\*\*|__|\*|_|`)(\S(?:[^\n]*?\S)?)\2(?=[\s).,;:!?]|$)/gm, "$1$3")
    .replace(/\s+/g, " ")
    .trim();

const projectsBody = (home: Home | null): string => {
  const rows = (home?.projects ?? []).map((project) => {
    const href = project.url ?? (project.repo ? `https://github.com/${project.repo}` : "");
    const name = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(project.name)}</a>`
      : `<a>${esc(project.name)}</a>`;
    const tags = project.tags.length ? `<span class="tag">${esc(project.tags.join(" · "))}</span>` : "";
    return `<li>${name}<span>${esc(project.description)}</span>${tags}</li>`;
  });
  return `<h2>Projects</h2><ul class="list">${rows.join("")}</ul>`;
};

const postsBody = (home: Home | null): string => {
  const all = [...(home?.posts ?? []), ...(home?.book_reviews ?? [])];
  const rows = all.map(
    (post) => `
      <li>
        <a href="/posts/${esc(post.slug)}">${esc(post.title)}</a>
        <span>${esc(plainText(post.excerpt))}</span>
        <span class="tag">${fmtDate(post.published_at)}</span>
      </li>`,
  );
  return `<h2>Writing</h2><ul class="list">${rows.join("")}</ul>`;
};

const nowBody = (home: Home | null): string => {
  const rows = (home?.details ?? [])
    .filter((d) => d.key !== "email")
    .map((d) => {
      const value = d.url
        ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.value)}</a>`
        : esc(d.value);
      return `<dt>${esc(d.label.toLowerCase())}</dt><dd>${value}</dd>`;
    });
  return `
    <h2>Now</h2>
    <dl class="kv">
      ${rows.join("")}
      <dt>your time</dt><dd data-clock>--:--:--</dd>
    </dl>`;
};

const contactBody = (home: Home | null): string => {
  const email = detail(home, "email")?.value;
  const github = home?.profile.github_url;
  const emailRow = email
    ? `<dt>email</dt>
       <dd><span class="email" id="email">${esc(email)}</span>
       <button class="btn" id="copy-email" type="button">Copy</button></dd>`
    : "";
  const githubRow = github
    ? `<dt>github</dt>
       <dd><a href="${esc(github)}" target="_blank" rel="noopener">${esc(bareUrl(github))}</a></dd>`
    : "";
  return `
    <div class="contact">
      <h2>Say hello</h2>
      <form class="msg" id="msg-form">
        <textarea id="msg-text" rows="4" maxlength="600" placeholder="Hello Andrew"
          aria-label="Message"></textarea>
        <div class="msg-row">
          <input id="msg-from" type="text" maxlength="120" placeholder="from"
            aria-label="Your name or email" autocomplete="off">
          <button class="btn" id="msg-send" type="submit">Send</button>
        </div>
        <p class="tag" id="msg-status" aria-live="polite"></p>
      </form>
      <dl class="reach">${emailRow}${githubRow}</dl>
    </div>`;
};

const fetchBody = (): string => `
  <div class="fetch-top">
    <div class="logo" id="logo" role="img" aria-label="AM"></div>
    <h2>andrew@nixos</h2>
  </div>
  <dl class="kv">
    <dt>os</dt><dd>NixOS</dd>
    <dt>wm</dt><dd>Hyprland</dd>
    <dt>editor</dt><dd>NeoVim</dd>
    <dt>uptime</dt><dd id="uptime">on GitHub since April 2021</dd>
    <dt>langs</dt><dd>Rust first. Then TypeScript, Java, C#, Delphi, BBC BASIC</dd>
    <dt>building</dt><dd>a multiplayer game, slowly</dd>
    <dt>running</dt><dd>a few small sites and services</dd>
    <dt>homelab</dt><dd>self-hosted, deploys on push</dd>
    <dt>lints</dt><dd>unwrap denied, colour spelt properly</dd>
  </dl>
  <div class="swatches" aria-hidden="true">
    ${["about", "projects", "fetch", "life", "term", "posts", "contact", "now"]
      .map((app) => `<i style="background: var(--w-${app})"></i>`)
      .join("")}
  </div>`;

const termBody = (): string => `
  <div class="term" id="term-log" aria-live="polite"><div>Type help to see what this can do.</div></div>
  <form class="term-line" id="term-form">
    <label for="term-in" id="term-ps">andrew@portfolio:~$</label>
    <input id="term-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
  </form>`;

const BODIES: Record<string, (home: Home | null) => string> = {
  about: aboutBody,
  projects: projectsBody,
  posts: postsBody,
  now: nowBody,
  contact: contactBody,
  fetch: fetchBody,
  term: termBody,
};

const windowHtml = (def: WinDef, home: Home | null): string => `
  <section class="win" data-app="${def.app}" style="--w: var(--w-${def.app})" tabindex="0"
    aria-label="${esc(def.label)}" hidden>
    <div class="win-bar">
      <span>${esc(def.title)}</span>
      <button class="win-x" type="button" aria-label="Close ${esc(def.app)}">×</button>
    </div>
    <div class="win-body">${BODIES[def.app]?.(home) ?? ""}</div>
  </section>`;

export const shell = (home: Home | null): string => `
  <div class="screen">
    <header class="bar">
      <nav class="apps" id="apps" aria-label="Sections"></nav>
      <div class="bar-right">
        <input type="range" id="hue" min="0" max="360" step="1" value="0" aria-label="Colour"
          title="Turn every colour on the page">
        <button class="pill" id="static" type="button"
          title="Switch between the window manager and a plain page">static</button>
        <button class="pill" id="layout" type="button"
          title="Change how windows are arranged">dwindle</button>
        <span class="clock" data-clock title="Your local time">--:--:--</span>
        <span id="zone" title="Your time zone"></span>
      </div>
    </header>
    <div class="menu" id="toys-menu" role="menu" aria-label="Toys" hidden></div>
    <main class="desk" id="desk">
      ${WINDOWS.map((def) => windowHtml(def, home)).join("")}
      <div class="empty" id="empty" hidden>
        <div class="void" id="void" aria-hidden="true"></div>
        <span>nothing open</span>
      </div>
    </main>
    <footer class="keys" aria-label="Status and keyboard shortcuts">
      <span>
        <span id="status"></span>
        <button class="pill" id="close-all" type="button" aria-label="Close every window"
          title="Close every window" hidden>×</button>
      </span>
      <div class="hints">
        <span><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd> focus</span>
        <span><kbd>shift</kbd><kbd>h</kbd><kbd>l</kbd> swap</span>
        <span>drag a title bar to swap</span>
        <span><kbd>m</kbd> max</span>
        <span><kbd>q</kbd> close</span>
        <span><kbd>space</kbd> layout</span>
      </div>
    </footer>
  </div>`;
