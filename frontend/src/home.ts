// The front page: home content rendered beneath the eroding Game of Life
// canvas. Posts sit in the first viewport so erosion reveals them without
// scrolling; the profile, GitHub activity and pinned projects follow.

import secret_canvas from "./secret_canvas";
import { initProfilePhoto } from "./profile_photo";
import { api, esc, fmtDate } from "./helpers";
import { renderMarkdown } from "./markdown";

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
  posts: {
    slug: string;
    title: string;
    excerpt: string;
    published_at: string | null;
  }[];
};

const section = (title: string, inner: string) => `
  <section class="w-full max-w-3xl mx-auto px-6 py-10">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest mb-4">${title}</h2>
    ${inner}
  </section>`;

const renderHome = (root: HTMLElement, home: Home) => {
  const { profile, projects, commits, posts } = home;

  const about = `
    <div class="flex flex-col sm:flex-row gap-6 items-start">
      ${
        profile.profile_image_url
          ? `<div class="shrink-0 border-2 border-green-600 w-44 h-44 rounded-full overflow-hidden">
               <canvas class="profile-photo w-full h-full rounded-full" aria-label="Andrew McCall"
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
      <tr class="border-b border-green-900/40 hover:bg-stone-900/60 cursor-pointer" data-url="${esc(c.url)}">
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
             class="text-green-500 hover:text-green-400 underline">${esc(profile.github_url.replace(/^https?:\/\//, ""))}</a>`
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
      <div class="border border-green-900 bg-stone-900 p-5 flex flex-col gap-2">
        <h3 class="text-lg font-bold text-lime-300">${esc(p.name)}</h3>
        <p class="text-sm text-stone-300 leading-relaxed flex-1">${esc(p.description)}</p>
        <div class="flex gap-4 text-sm">
          ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="text-green-500 hover:text-green-400 underline">visit</a>` : ""}
          ${p.repo ? `<a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener" class="text-green-500 hover:text-green-400 underline">source</a>` : ""}
        </div>
      </div>`,
    )
    .join("");

  const postCards = posts
    .map(
      (p) => `
      <a href="/posts/${esc(p.slug)}" class="block border border-green-900 bg-stone-900 p-5 hover:border-green-700 transition-colors">
        <div class="flex items-baseline justify-between gap-4">
          <h3 class="text-lg font-bold text-lime-300">${esc(p.title)}</h3>
          <span class="text-green-700 text-sm whitespace-nowrap">${fmtDate(p.published_at)}</span>
        </div>
        <p class="text-sm text-stone-400 leading-relaxed mt-2">${esc(p.excerpt)}</p>
      </a>`,
    )
    .join("");

  root.innerHTML = `
    ${
      posts.length > 0
        ? section(
            "Posts",
            `<div class="flex flex-col gap-4">${postCards}</div>
             <a href="/posts" class="inline-block mt-4 text-green-500 hover:text-green-400 underline text-sm">all posts →</a>`,
          )
        : ""
    }
    ${about.trim() && profile.intro_markdown ? section("About", about) : ""}
    ${profile.github_url || commits.length > 0 ? section("GitHub", github) : ""}
    ${projects.length > 0 ? section("Projects", `<div class="grid sm:grid-cols-2 gap-4">${projectCards}</div>`) : ""}`;

  for (const row of root.querySelectorAll<HTMLTableRowElement>(
    "tr[data-url]",
  )) {
    row.onclick = () => window.open(row.dataset.url, "_blank", "noopener");
  }

  const photo = root.querySelector<HTMLCanvasElement>("canvas.profile-photo");
  if (photo) initProfilePhoto(photo, photo.dataset.src!);
};

export default async (app: HTMLElement) => {
  app.innerHTML = `
    <main id="home-content" class="text-green-500 pt-6 pb-16 select-text"></main>`;

  secret_canvas();

  const content = app.querySelector<HTMLElement>("#home-content")!;
  try {
    const res = await api("/home");
    if (!res.ok) return;
    renderHome(content, (await res.json()) as Home);
  } catch {
    // The canvas still works without the content; fail quietly.
  }
};
