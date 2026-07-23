// Public blog: the /posts list and /posts/{slug} detail pages.

import { api, esc, fmtDate, readingTime, setMeta } from "./helpers";
import { renderMarkdown } from "./markdown";

type PostSummary = {
  slug: string;
  title: string;
  excerpt: string;
  published_at: string | null;
};

type Post = {
  slug: string;
  title: string;
  body: string;
  published_at: string | null;
};

const PAGE_SIZE = 8; // list entries shown before "load more"

const shell = (inner: string) => `
  <div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500 select-text">
    <div class="w-full max-w-3xl">
      <a href="/" title="Home">
        <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
          Posts
        </h1>
      </a>
      <div class="mt-8 flex flex-col gap-4">${inner}</div>
    </div>
  </div>`;

// A pulsing placeholder card, repeated while a request is in flight.
const skeletons = (n: number) =>
  Array.from(
    { length: n },
    () => `
    <div class="border border-green-900 bg-stone-900 p-5 animate-pulse">
      <div class="h-5 w-1/2 bg-green-900/60 rounded"></div>
      <div class="h-3 w-full bg-stone-800 rounded mt-4"></div>
      <div class="h-3 w-4/5 bg-stone-800 rounded mt-2"></div>
    </div>`,
  ).join("");

// A retryable error block. `onRetry` is wired by the caller after injection.
const errorBlock = (msg: string) => `
  <div class="flex flex-col gap-3">
    <p class="text-red-400">${esc(msg)}</p>
    <button class="retry self-start border border-green-800 text-green-400 hover:border-green-600 px-3 py-1 text-sm">
      retry
    </button>
  </div>`;

const card = (p: PostSummary) => `
  <a href="/posts/${esc(p.slug)}" class="block border border-green-900 bg-stone-900 p-5 hover:border-green-700 transition-colors">
    <div class="flex items-baseline justify-between gap-4">
      <h2 class="text-lg font-bold text-lime-300">${esc(p.title)}</h2>
      <span class="text-green-700 text-sm whitespace-nowrap">${fmtDate(p.published_at)}</span>
    </div>
    <p class="text-sm text-stone-400 leading-relaxed mt-2">${esc(p.excerpt)}</p>
  </a>`;

export const postsList = async (app: HTMLElement) => {
  setMeta("Posts — Andrew McCall", "Writing by Andrew McCall.");
  app.innerHTML = shell(skeletons(4));
  const container = app.querySelector<HTMLElement>(".mt-8")!;

  const load = async () => {
    container.innerHTML = skeletons(4);
    try {
      const res = await api("/posts");
      if (!res.ok) throw new Error("bad status");
      const posts = (await res.json()) as PostSummary[];
      if (posts.length === 0) {
        container.innerHTML = `<p class="text-green-700">Nothing here yet.</p>`;
        return;
      }
      renderList(container, posts);
    } catch {
      container.innerHTML = errorBlock("Failed to load posts.");
      container
        .querySelector<HTMLButtonElement>(".retry")
        ?.addEventListener("click", load);
    }
  };

  await load();
};

// Renders the search box, the paged results, and a "load more" button, wiring
// filtering and paging over the in-memory `posts` array.
const renderList = (container: HTMLElement, posts: PostSummary[]) => {
  container.innerHTML = `
    <input type="search" placeholder="search posts…" aria-label="Search posts"
      class="search bg-stone-900 border border-green-900 focus:border-green-600 outline-none
             text-green-300 placeholder-green-800 px-3 py-2 w-full font-mono text-sm" />
    <div class="results flex flex-col gap-4"></div>
    <button class="more self-center border border-green-800 text-green-400 hover:border-green-600 px-4 py-1 text-sm hidden">
      load more
    </button>`;

  const search = container.querySelector<HTMLInputElement>(".search")!;
  const results = container.querySelector<HTMLElement>(".results")!;
  const more = container.querySelector<HTMLButtonElement>(".more")!;

  let filtered = posts;
  let shown = 0;

  const paint = () => {
    results.innerHTML =
      filtered.length === 0
        ? `<p class="text-green-700">No posts match “${esc(search.value)}”.</p>`
        : filtered.slice(0, shown).map(card).join("");
    more.classList.toggle("hidden", shown >= filtered.length);
  };

  const apply = () => {
    const q = search.value.trim().toLowerCase();
    filtered = q
      ? posts.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.excerpt.toLowerCase().includes(q),
        )
      : posts;
    shown = Math.min(PAGE_SIZE, filtered.length);
    paint();
  };

  more.addEventListener("click", () => {
    shown = Math.min(shown + PAGE_SIZE, filtered.length);
    paint();
  });
  search.addEventListener("input", apply);
  apply();
};

export const postPage = async (app: HTMLElement, slug: string) => {
  app.innerHTML = shell(skeletons(1));
  const container = app.querySelector<HTMLElement>(".mt-8")!;

  const load = async () => {
    container.innerHTML = skeletons(1);
    try {
      // The detail plus the full list, so we can render neighbour links.
      const [res, listRes] = await Promise.all([
        api(`/posts/${encodeURIComponent(slug)}`),
        api("/posts"),
      ]);
      if (res.status === 404) {
        setMeta("Post not found — Andrew McCall", "This post does not exist.");
        container.innerHTML = `
          <p class="text-red-400">Post not found.</p>
          <a href="/posts" class="text-green-500 hover:text-green-400 underline text-sm">← all posts</a>`;
        return;
      }
      if (!res.ok) throw new Error("bad status");
      const post = (await res.json()) as Post;
      const list = listRes.ok
        ? ((await listRes.json()) as PostSummary[])
        : [];
      renderPost(container, post, list);
    } catch {
      container.innerHTML = errorBlock("Network error.");
      container
        .querySelector<HTMLButtonElement>(".retry")
        ?.addEventListener("click", load);
    }
  };

  await load();
};

const renderPost = (
  container: HTMLElement,
  post: Post,
  list: PostSummary[],
) => {
  const plain = post.body.slice(0, 160).replace(/[#*`>\n]/g, " ").trim();
  setMeta(`${post.title} — Andrew McCall`, plain || post.title);

  const idx = list.findIndex((p) => p.slug === post.slug);
  const newer = idx > 0 ? list[idx - 1] : null; // list is newest-first
  const older = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  const nav = (p: PostSummary | null, label: string, side: "l" | "r") =>
    p
      ? `<a href="/posts/${esc(p.slug)}" class="flex-1 min-w-0 border border-green-900 hover:border-green-700 transition-colors p-3 ${side === "r" ? "text-right" : ""}">
           <div class="text-green-700 text-xs">${label}</div>
           <div class="text-lime-300 text-sm truncate">${esc(p.title)}</div>
         </a>`
      : `<div class="flex-1"></div>`;

  container.innerHTML = `
    <article class="flex flex-col gap-3 text-stone-300">
      <h2 class="text-2xl md:text-3xl font-bold text-lime-300">${esc(post.title)}</h2>
      <div class="flex items-center gap-3 text-green-700 text-sm">
        <span>${fmtDate(post.published_at)}</span>
        <span aria-hidden="true">·</span>
        <span>${readingTime(post.body)} min read</span>
        <button class="copy ml-auto border border-green-900 hover:border-green-600 px-2 py-0.5 text-green-500">
          copy link
        </button>
      </div>
      ${renderMarkdown(post.body)}
    </article>
    <nav class="flex gap-3 mt-8">
      ${nav(newer, "← Newer", "l")}
      ${nav(older, "Older →", "r")}
    </nav>
    <a href="/posts" class="text-green-500 hover:text-green-400 underline text-sm mt-6">← all posts</a>`;

  const copy = container.querySelector<HTMLButtonElement>(".copy")!;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copy.textContent = "copied!";
      setTimeout(() => (copy.textContent = "copy link"), 1500);
    } catch {
      copy.textContent = "copy failed";
      setTimeout(() => (copy.textContent = "copy link"), 1500);
    }
  });

  // Jump to a hash target once the article is in the DOM. The hash is
  // attacker-controllable, so an invalid selector must not throw.
  if (window.location.hash) {
    try {
      container
        .querySelector(window.location.hash)
        ?.scrollIntoView({ behavior: "smooth" });
    } catch {
      // Malformed hash — nothing to scroll to.
    }
  }
};
