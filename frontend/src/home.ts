// The front page: home content rendered beneath the eroding Game of Life
// canvas. Posts sit in the first viewport so erosion reveals them without
// scrolling; the profile, GitHub activity and pinned projects follow.

import secret_canvas from "./secret_canvas";
import { initProfilePhoto } from "./profile_photo";
import {
  api,
  backendHealthy,
  bareUrl,
  esc,
  extLink,
  fmtDate,
  setMeta,
  CARD_LIFT_CLASS,
  LINK_CLASS,
  SITE_TITLE,
  SITE_DESCRIPTION,
} from "./helpers";
import { postCard, type PostSummary } from "./post_card";
import { renderMarkdown } from "./markdown";
import { getMe } from "./session";
// Generated from `HomeJson` in `backend/src/site.rs` — see `backend/build.rs`.
import type { Home } from "@andrewmccall/api-types";

const section = (title: string, inner: string) => `
  <section class="w-full max-w-3xl mx-auto px-6 py-10">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest mb-4">${title}</h2>
    ${inner}
  </section>`;

// The "About" block: the profile photo (drawn into a canvas) beside the intro.
const aboutSection = (profile: Home["profile"]) => {
  if (!profile.intro_markdown) return "";
  const photo = profile.profile_image_url
    ? `<div class="shrink-0 w-full aspect-square sm:w-44 sm:h-44 sm:aspect-auto border-2 border-green-600 rounded-full overflow-hidden">
         <canvas class="profile-photo w-full h-full" aria-label="Andrew McCall"
           data-src="${esc(profile.profile_image_url)}"></canvas>
       </div>`
    : "";
  return section(
    "About",
    `<div class="flex flex-col sm:flex-row gap-6 items-start">
       ${photo}
       <div class="flex-1 flex flex-col gap-3 text-stone-300">
         ${renderMarkdown(profile.intro_markdown)}
       </div>
     </div>`,
  );
};

// The "Now" box: a fixed key/value table of what I'm currently up to. Its links
// sit on a green-300 value column, so they run a step brighter than LINK_CLASS.
const DETAIL_LINK_CLASS =
  "text-green-400 hover:text-green-300 underline cursor-pointer";

const nowSection = (details: Home["details"]) => {
  if (details.length === 0) return "";
  const rows = details
    .map(
      (f) => `
      <tr class="border-b border-green-900/40">
        <td class="py-2 pr-6 text-green-700 whitespace-nowrap align-top">${esc(f.label)}</td>
        <td class="py-2 text-green-300">${
          f.url ? extLink(f.url, f.value, DETAIL_LINK_CLASS) : esc(f.value)
        }</td>
      </tr>`,
    )
    .join("");
  return section(
    "Now",
    `<div class="overflow-x-auto">
       <table class="w-full text-left font-mono text-sm"><tbody>${rows}</tbody></table>
     </div>`,
  );
};

// Recent commits; each row opens the commit on GitHub (wired after injection).
const githubSection = (profile: Home["profile"], commits: Home["commits"]) => {
  if (!profile.github_url && commits.length === 0) return "";
  const rows = commits
    .map(
      (c) => `
      <tr class="border-b border-green-900/40 hover:bg-stone-800 cursor-pointer transition-colors" data-url="${esc(c.url)}">
        <td class="py-2 pr-4 text-green-700 whitespace-nowrap">${esc(c.repo.split("/")[1] ?? c.repo)}</td>
        <td class="py-2 pr-4 text-green-300">${esc(c.message.split("\n")[0].slice(0, 80))}</td>
        <td class="py-2 text-green-700 whitespace-nowrap">${fmtDate(c.committed_at)}</td>
      </tr>`,
    )
    .join("");
  const table =
    commits.length > 0
      ? `<div class="overflow-x-auto mt-4">
           <table class="w-full text-left font-mono text-sm">
             <thead class="text-green-700 border-b border-green-900">
               <tr><th class="py-2 pr-4">Repo</th><th class="py-2 pr-4">Commit</th><th class="py-2">When</th></tr>
             </thead>
             <tbody>${rows}</tbody>
           </table>
         </div>`
      : "";
  const link = profile.github_url
    ? extLink(profile.github_url, bareUrl(profile.github_url))
    : "";
  return section("GitHub", `${link}${table}`);
};

// Same chip as the notes browser, so a tag looks like a tag everywhere.
const TAG_CHIP =
  "text-green-600 bg-green-900/30 px-1.5 py-0.5 text-xs font-mono whitespace-nowrap";

const tagChips = (tags: string[]) =>
  tags.length > 0
    ? `<div class="flex flex-wrap gap-1">${tags
        .map((t) => `<span class="${TAG_CHIP}">${esc(t)}</span>`)
        .join("")}</div>`
    : "";

const projectsSection = (projects: Home["projects"]) => {
  if (projects.length === 0) return "";
  const cards = projects
    .map(
      (p) => `
      <div class="border border-green-900 bg-stone-900 p-5 flex flex-col gap-2 ${CARD_LIFT_CLASS}">
        <h3 class="text-lg font-bold text-lime-300">${esc(p.name)}</h3>
        <p class="text-sm text-stone-300 leading-relaxed flex-1">${esc(p.description)}</p>
        ${tagChips(p.tags)}
        <div class="flex gap-4 text-sm">
          ${p.url ? extLink(p.url, "visit ↗") : ""}
          ${p.repo ? extLink(`https://github.com/${p.repo}`, "source ↗") : ""}
        </div>
      </div>`,
    )
    .join("");
  return section(
    "Projects",
    `<div class="grid sm:grid-cols-2 gap-4">${cards}</div>`,
  );
};

// A "Posts"/"Book Reviews" block: its cards plus a link through to the full,
// filterable /posts page.
const postSection = (
  title: string,
  list: PostSummary[],
  more: string,
  href: string,
) =>
  list.length > 0
    ? section(
        title,
        `<div class="flex flex-col gap-4">${list.map((p) => postCard(p, "home")).join("")}</div>
         <a href="${href}" class="inline-block mt-4 ${LINK_CLASS} text-sm">${more} →</a>`,
      )
    : "";

const renderHome = (root: HTMLElement, home: Home) => {
  const { profile, projects, commits, posts, book_reviews, details } = home;

  // Search-result copy, editable from the admin profile page. Blank there means
  // "keep the build-time default", which index.html is already showing — so the
  // tags stay correct even when this never runs because the API is down.
  //
  // Restoring it on every render matters for more than the first paint: a
  // visitor who opens a post and clicks back reaches this page without a reload,
  // and the head would otherwise still be describing the post.
  setMeta(
    profile.seo_title || SITE_TITLE,
    profile.seo_description || SITE_DESCRIPTION,
  );

  root.innerHTML = `
    ${aboutSection(profile)}
    ${githubSection(profile, commits)}
    ${nowSection(details)}
    ${postSection("Posts", posts, "all posts", "/posts")}
    ${postSection("Book Reviews", book_reviews, "all reviews", "/posts#reviews")}
    ${projectsSection(projects)}`;

  for (const row of root.querySelectorAll<HTMLTableRowElement>(
    "tr[data-url]",
  )) {
    row.onclick = () => window.open(row.dataset.url, "_blank", "noopener");
  }

  const photo = root.querySelector<HTMLCanvasElement>("canvas.profile-photo");
  if (photo) initProfilePhoto(photo, photo.dataset.src!);
};

// After this long on the front page, a large button surfaces at the very bottom
// as an overt route into the secret menu (the click-counter easter egg aside).
const SECRET_BTN_DELAY_MS = 180_000;

export default async (app: HTMLElement) => {
  app.innerHTML = `
    <main id="home-content" class="text-green-500 pt-[16vmin] pb-16 min-h-[150vh]"></main>`;

  // Signed-in visitors have already seen the erosion reveal, so bring the board
  // up cleared for them — as if the "clear" button had been pressed. Signed in
  // also earns the board's own "secret" control, which the canvas adds itself.
  secret_canvas(getMe().then((me) => me !== null));

  // Large secret-menu button at the very bottom, revealed after the delay. It
  // sits above the fixed board (z-60) so it's directly clickable once reached.
  const secretBtn = document.createElement("button");
  secretBtn.textContent = ">_ enter the secret menu →";
  secretBtn.className =
    "relative z-[60] block w-full max-w-3xl mx-auto mb-24 px-8 py-8 " +
    "text-2xl font-bold tracking-widest uppercase text-lime-300 " +
    "border-2 border-green-600 bg-stone-900 cursor-pointer ease-out " +
    "hover:bg-stone-800 hover:border-green-500 hover:text-lime-200 " +
    "hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-2px_rgba(34,197,94,0.25)] " +
    "active:translate-y-0 active:shadow-none";
  secretBtn.addEventListener("click", () => window.navigate("/secret"));
  secretBtn.style.cssText +=
    "opacity:0;pointer-events:none;" +
    "transition:opacity 1s,transform .15s,box-shadow .15s,background-color .15s,border-color .15s,color .15s";
  app.appendChild(secretBtn);
  setTimeout(async () => {
    if (!secretBtn.isConnected) return; // left the front page before it fired
    // The button sits above the board (z-60), so unlike the rest of the page it
    // isn't sealed off by an opaque canvas — check the backend before offering
    // it, since with the API down the secret menu has nothing to show.
    if (!(await backendHealthy()) || !secretBtn.isConnected) return;
    secretBtn.style.opacity = "1";
    secretBtn.style.pointerEvents = "auto";
  }, SECRET_BTN_DELAY_MS);

  const content = app.querySelector<HTMLElement>("#home-content")!;
  try {
    const res = await api("/home");
    if (!res.ok) return;
    renderHome(content, (await res.json()) as Home);
  } catch {
    // The canvas still works without the content; fail quietly.
  }
};
