// The front page: home content rendered beneath the eroding Game of Life
// canvas. Posts sit in the first viewport so erosion reveals them without
// scrolling; the profile, GitHub activity and pinned projects follow.

import secret_canvas from "./secret_canvas";
import { initProfilePhoto } from "./profile_photo";
import { api, backendHealthy, esc, fmtDate } from "./helpers";
import { renderMarkdown } from "./markdown";
import { getMe } from "./session";

type PostSummary = {
  slug: string;
  title: string;
  excerpt: string;
  published_at: string | null;
  post_type: "article" | "book_review";
  book_review?: {
    author: string;
    rating: number | null;
    cover_url: string | null;
  };
};

type Home = {
  profile: {
    intro_markdown: string;
    profile_image_url: string;
    github_url: string;
  };
  projects: {
    name: string;
    description: string;
    url: string | null;
    repo: string | null;
  }[];
  commits: {
    sha: string;
    repo: string;
    message: string;
    url: string;
    committed_at: string;
  }[];
  posts: PostSummary[];
  book_reviews: PostSummary[];
  details: {
    key: string;
    label: string;
    value: string;
    url: string | null;
  }[];
};

const section = (title: string, inner: string) => `
  <section class="w-full max-w-3xl mx-auto px-6 py-10">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest mb-4">${title}</h2>
    ${inner}
  </section>`;

const renderHome = (root: HTMLElement, home: Home) => {
  const { profile, projects, commits, posts, book_reviews, details } = home;

  // The "Now" box: a fixed key/value table of what I'm currently up to.
  const detailRows = details
    .map(
      (f) => `
      <tr class="border-b border-green-900/40">
        <td class="py-2 pr-6 text-green-700 whitespace-nowrap align-top">${esc(f.label)}</td>
        <td class="py-2 text-green-300">${
          f.url
            ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" class="text-green-400 hover:text-green-300 underline cursor-pointer">${esc(f.value)}</a>`
            : esc(f.value)
        }</td>
      </tr>`,
    )
    .join("");
  const now = `
    <div class="overflow-x-auto">
      <table class="w-full text-left font-mono text-sm"><tbody>${detailRows}</tbody></table>
    </div>`;

  const about = `
    <div class="flex flex-col sm:flex-row gap-6 items-start">
      ${
        profile.profile_image_url
          ? `<div class="shrink-0 w-full aspect-square sm:w-44 sm:h-44 sm:aspect-auto border-2 border-green-600 rounded-full overflow-hidden">
               <canvas class="profile-photo w-full h-full" aria-label="Andrew McCall"
                 data-src="${esc(profile.profile_image_url)}"></canvas>
             </div>`
          : ""
      }
      <div class="flex-1 flex flex-col gap-3 text-stone-300">
        ${renderMarkdown(profile.intro_markdown)}
      </div>
    </div>`;

  const commitRows = commits
    .map(
      (c) => `
      <tr class="border-b border-green-900/40 hover:bg-stone-800 cursor-pointer transition-colors" data-url="${esc(c.url)}">
        <td class="py-2 pr-4 text-green-700 whitespace-nowrap">${esc(c.repo.split("/")[1] ?? c.repo)}</td>
        <td class="py-2 pr-4 text-green-300">${esc(c.message.split("\n")[0].slice(0, 80))}</td>
        <td class="py-2 text-green-700 whitespace-nowrap">${fmtDate(c.committed_at)}</td>
      </tr>`,
    )
    .join("");
  const github = `
    ${
      profile.github_url
        ? `<a href="${esc(profile.github_url)}" target="_blank" rel="noopener"
             class="text-green-500 hover:text-green-400 underline cursor-pointer">${esc(profile.github_url.replace(/^https?:\/\//, ""))}</a>`
        : ""
    }
    ${
      commits.length > 0
        ? `<div class="overflow-x-auto mt-4">
             <table class="w-full text-left font-mono text-sm">
               <thead class="text-green-700 border-b border-green-900">
                 <tr><th class="py-2 pr-4">Repo</th><th class="py-2 pr-4">Commit</th><th class="py-2">When</th></tr>
               </thead>
               <tbody>${commitRows}</tbody>
             </table>
           </div>`
        : ""
    }`;

  const projectCards = projects
    .map(
      (p) => `
      <div class="border border-green-900 bg-stone-900 p-5 flex flex-col gap-2 transition-all duration-150 ease-out hover:border-green-500 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-2px_rgba(34,197,94,0.25)] active:translate-y-0 active:shadow-none">
        <h3 class="text-lg font-bold text-lime-300">${esc(p.name)}</h3>
        <p class="text-sm text-stone-300 leading-relaxed flex-1">${esc(p.description)}</p>
        <div class="flex gap-4 text-sm">
          ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="text-green-500 hover:text-green-400 underline cursor-pointer">visit ↗</a>` : ""}
          ${p.repo ? `<a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener" class="text-green-500 hover:text-green-400 underline cursor-pointer">source ↗</a>` : ""}
        </div>
      </div>`,
    )
    .join("");

  // A ★★★☆☆ rating out of 5, blank when unrated.
  const stars = (rating: number | null) => {
    if (!rating) return "";
    const n = Math.max(0, Math.min(5, rating));
    return `<span class="text-yellow-500">${"★".repeat(n)}<span class="text-green-900">${"★".repeat(5 - n)}</span></span>`;
  };

  const postCard = (p: PostSummary) => {
    const br = p.post_type === "book_review" ? p.book_review : undefined;
    const cover = br?.cover_url
      ? `<img src="${esc(br.cover_url)}" alt="" loading="lazy"
             class="shrink-0 w-14 h-20 object-cover border border-green-900 bg-stone-950" />`
      : "";
    const meta = br
      ? `<div class="flex items-center gap-2 text-xs text-green-700 mt-1">
           ${br.author ? `<span>${esc(br.author)}</span>` : ""}${stars(br.rating)}
         </div>`
      : "";
    return `
      <a href="/posts/${esc(p.slug)}" class="group flex gap-4 border border-green-900 bg-stone-900 p-5 cursor-pointer transition-all duration-150 ease-out hover:border-green-500 hover:bg-stone-800 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-2px_rgba(34,197,94,0.25)] active:translate-y-0 active:shadow-none">
        ${cover}
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-4">
            <h3 class="text-lg font-bold text-lime-300 transition-colors group-hover:text-lime-200">${esc(p.title)}</h3>
            <span class="text-green-700 text-sm whitespace-nowrap">${fmtDate(p.published_at)}</span>
          </div>
          ${meta}
          <p class="text-sm text-stone-400 leading-relaxed mt-2">${esc(p.excerpt)}</p>
        </div>
      </a>`;
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
          `<div class="flex flex-col gap-4">${list.map(postCard).join("")}</div>
           <a href="${href}" class="inline-block mt-4 text-green-500 hover:text-green-400 underline text-sm cursor-pointer">${more} →</a>`,
        )
      : "";

  root.innerHTML = `
    ${about.trim() && profile.intro_markdown ? section("About", about) : ""}
    ${details.length > 0 ? section("Now", now) : ""}
    ${profile.github_url || commits.length > 0 ? section("GitHub", github) : ""}
    ${postSection("Posts", posts, "all posts", "/posts")}
    ${postSection("Book Reviews", book_reviews, "all reviews", "/posts#reviews")}
    ${projects.length > 0 ? section("Projects", `<div class="grid sm:grid-cols-2 gap-4">${projectCards}</div>`) : ""}`;

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

const SECRET_BTN_CLASS =
  "relative z-[60] block w-full max-w-3xl mx-auto px-8 py-8 " +
  "text-2xl font-bold tracking-widest uppercase text-lime-300 " +
  "border-2 border-green-600 bg-stone-900 cursor-pointer ease-out " +
  "hover:bg-stone-800 hover:border-green-500 hover:text-lime-200 " +
  "hover:-translate-y-0.5 hover:shadow-[0_4px_16px_-2px_rgba(34,197,94,0.25)] " +
  "active:translate-y-0 active:shadow-none";

export default async (app: HTMLElement) => {
  app.innerHTML = `
    <main id="home-content" class="text-green-500 pt-[16vmin] pb-16 min-h-[150vh] select-text"></main>`;

  // Signed-in visitors have already seen the erosion reveal, so bring the board
  // up cleared for them — as if the "clear" button had been pressed.
  const signedIn = getMe().then((me) => me !== null);
  secret_canvas(signedIn);

  // Signed-in visitors skip the wait: the same button also sits at the very top,
  // above the canvas, as soon as the session resolves.
  signedIn.then((yes) => {
    if (!yes || !app.isConnected) return;
    const topBtn = document.createElement("button");
    topBtn.textContent = ">_ enter the secret menu →";
    topBtn.className = SECRET_BTN_CLASS + " mt-6 mb-4";
    topBtn.addEventListener("click", () => window.navigate("/secret"));
    app.prepend(topBtn);
  });

  // Large secret-menu button at the very bottom, revealed after the delay. It
  // sits above the fixed board (z-60) so it's directly clickable once reached.
  const secretBtn = document.createElement("button");
  secretBtn.textContent = ">_ enter the secret menu →";
  secretBtn.className = SECRET_BTN_CLASS + " mb-24";
  secretBtn.style.cssText +=
    "opacity:0;pointer-events:none;" +
    "transition:opacity 1s,transform .15s,box-shadow .15s,background-color .15s,border-color .15s,color .15s";
  secretBtn.addEventListener("click", () => window.navigate("/secret"));
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
