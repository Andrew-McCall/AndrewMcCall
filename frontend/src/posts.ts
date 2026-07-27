// Public blog: the /posts list and /posts/{slug} detail pages.

import { api, esc, fmtDate, readingTime, setMeta } from "./helpers";
import { renderMarkdown } from "./markdown";

type PostType = "article" | "book_review";

type BookReview = {
  book_title: string;
  author: string;
  rating: number | null;
  cover_url: string | null;
  isbn: string | null;
  read_date: string | null;
  link: string | null;
};

type PostSummary = {
  slug: string;
  title: string;
  excerpt: string;
  published_at: string | null;
  post_type: PostType;
  book_review?: BookReview;
};

type Post = {
  slug: string;
  title: string;
  body: string;
  published_at: string | null;
  post_type: PostType;
  book_review?: BookReview;
};

// A ★★★☆☆ rating out of 5, or empty for an unrated review.
const stars = (rating: number | null): string => {
  if (!rating) return "";
  const n = Math.max(0, Math.min(5, rating));
  return `<span class="text-yellow-500" aria-label="${n} out of 5">${"★".repeat(n)}<span class="text-green-900">${"★".repeat(5 - n)}</span></span>`;
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

const card = (p: PostSummary) => {
  const br = p.post_type === "book_review" ? p.book_review : undefined;
  const cover =
    br?.cover_url
      ? `<img src="${esc(br.cover_url)}" alt="" loading="lazy"
             class="shrink-0 w-16 h-24 object-cover border border-green-900 bg-stone-950" />`
      : "";
  const meta = br
    ? `<div class="flex items-center gap-2 text-xs text-green-700 mt-1">
         ${br.author ? `<span>${esc(br.author)}</span>` : ""}
         ${br.rating ? stars(br.rating) : ""}
       </div>`
    : "";
  return `
  <a href="/posts/${esc(p.slug)}" class="flex gap-4 border border-green-900 bg-stone-900 p-5 hover:border-green-700 transition-colors">
    ${cover}
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="text-lg font-bold text-lime-300">${esc(p.title)}</h2>
        <span class="text-green-700 text-sm whitespace-nowrap">${fmtDate(p.published_at)}</span>
      </div>
      ${meta}
      <p class="text-sm text-stone-400 leading-relaxed mt-2">${esc(p.excerpt)}</p>
    </div>
  </a>`;
};

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

// The type filters offered above the list. `all` disables type filtering.
const TYPE_FILTERS: { value: PostType | "all"; label: string }[] = [
  { value: "all", label: "all" },
  { value: "article", label: "articles" },
  { value: "book_review", label: "reviews" },
];

// Renders the type tabs, search box, paged results, and a "load more" button,
// wiring filtering and paging over the in-memory `posts` array.
const renderList = (container: HTMLElement, posts: PostSummary[]) => {
  const tabBtn = (f: (typeof TYPE_FILTERS)[number]) =>
    `<button class="tab border border-green-900 hover:border-green-600 px-3 py-1 text-sm text-green-500 data-[active=true]:bg-green-900/40 data-[active=true]:text-green-300"
       data-type="${f.value}">${f.label}</button>`;

  container.innerHTML = `
    <div class="tabs flex gap-2 flex-wrap">${TYPE_FILTERS.map(tabBtn).join("")}</div>
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
  const tabs = container.querySelectorAll<HTMLButtonElement>(".tab");

  // A `#reviews` / `#articles` hash (e.g. from the home page) preselects a tab.
  const fromHash: Record<string, PostType> = {
    "#reviews": "book_review",
    "#articles": "article",
  };
  let activeType: PostType | "all" = fromHash[window.location.hash] ?? "all";
  let filtered = posts;
  let shown = 0;

  const paint = () => {
    results.innerHTML =
      filtered.length === 0
        ? `<p class="text-green-700">No posts match.</p>`
        : filtered.slice(0, shown).map(card).join("");
    more.classList.toggle("hidden", shown >= filtered.length);
  };

  const apply = () => {
    const q = search.value.trim().toLowerCase();
    filtered = posts.filter((p) => {
      if (activeType !== "all" && p.post_type !== activeType) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.excerpt.toLowerCase().includes(q) ||
        (p.book_review?.author.toLowerCase().includes(q) ?? false)
      );
    });
    shown = Math.min(PAGE_SIZE, filtered.length);
    paint();
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      activeType = (tab.dataset.type as PostType | "all") ?? "all";
      for (const t of tabs)
        t.dataset.active = String(t.dataset.type === activeType);
      apply();
    });
  }
  for (const t of tabs) t.dataset.active = String(t.dataset.type === activeType);

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

  const br = post.post_type === "book_review" ? post.book_review : undefined;
  const reviewHeader = br
    ? `<div class="flex gap-5 border border-green-900 bg-stone-900/60 p-4">
         ${
           br.cover_url
             ? `<img src="${esc(br.cover_url)}" alt="" class="shrink-0 w-24 h-36 object-cover border border-green-900 bg-stone-950" />`
             : ""
         }
         <dl class="min-w-0 flex-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm self-center">
           ${br.book_title ? `<dt class="text-green-700">Book</dt><dd class="text-lime-300 truncate">${esc(br.book_title)}</dd>` : ""}
           ${br.author ? `<dt class="text-green-700">Author</dt><dd class="text-stone-300 truncate">${esc(br.author)}</dd>` : ""}
           ${br.rating ? `<dt class="text-green-700">Rating</dt><dd>${stars(br.rating)}</dd>` : ""}
           ${br.read_date ? `<dt class="text-green-700">Read</dt><dd class="text-stone-300">${fmtDate(br.read_date)}</dd>` : ""}
           ${br.isbn ? `<dt class="text-green-700">ISBN</dt><dd class="text-stone-300">${esc(br.isbn)}</dd>` : ""}
           ${br.link ? `<dt class="text-green-700">Link</dt><dd class="truncate"><a href="${esc(br.link)}" target="_blank" rel="noopener" class="text-green-500 hover:text-green-400 underline">${esc(br.link.replace(/^https?:\/\//, ""))}</a></dd>` : ""}
         </dl>
       </div>`
    : "";

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
      ${reviewHeader}
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
