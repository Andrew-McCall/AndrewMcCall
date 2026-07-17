// Public blog: the /posts list and /posts/{slug} detail pages.

import { api, esc, fmtDate } from "./helpers";
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

export const postsList = async (app: HTMLElement) => {
  app.innerHTML = shell(`<p class="text-green-700">loading…</p>`);
  const container = app.querySelector<HTMLElement>(".mt-8")!;
  try {
    const res = await api("/posts");
    if (!res.ok) {
      container.innerHTML = `<p class="text-red-400">Failed to load posts.</p>`;
      return;
    }
    const posts = (await res.json()) as PostSummary[];
    if (posts.length === 0) {
      container.innerHTML = `<p class="text-green-700">Nothing here yet.</p>`;
      return;
    }
    container.innerHTML = posts
      .map(
        (p) => `
        <a href="/posts/${esc(p.slug)}" class="block rounded-lg border border-green-900 bg-stone-900 p-5 hover:border-green-700 transition-colors">
          <div class="flex items-baseline justify-between gap-4">
            <h2 class="text-lg font-bold text-lime-300">${esc(p.title)}</h2>
            <span class="text-green-700 text-sm whitespace-nowrap">${fmtDate(p.published_at)}</span>
          </div>
          <p class="text-sm text-stone-400 leading-relaxed mt-2">${esc(p.excerpt)}</p>
        </a>`,
      )
      .join("");
  } catch {
    container.innerHTML = `<p class="text-red-400">Network error.</p>`;
  }
};

export const postPage = async (app: HTMLElement, slug: string) => {
  app.innerHTML = shell(`<p class="text-green-700">loading…</p>`);
  const container = app.querySelector<HTMLElement>(".mt-8")!;
  try {
    const res = await api(`/posts/${encodeURIComponent(slug)}`);
    if (!res.ok) {
      container.innerHTML = `
        <p class="text-red-400">Post not found.</p>
        <a href="/posts" class="text-green-500 hover:text-green-400 underline text-sm">← all posts</a>`;
      return;
    }
    const post = (await res.json()) as Post;
    container.innerHTML = `
      <article class="flex flex-col gap-3 text-stone-300">
        <h2 class="text-2xl md:text-3xl font-bold text-lime-300">${esc(post.title)}</h2>
        <p class="text-green-700 text-sm">${fmtDate(post.published_at)}</p>
        ${renderMarkdown(post.body)}
      </article>
      <a href="/posts" class="text-green-500 hover:text-green-400 underline text-sm mt-6">← all posts</a>`;
  } catch {
    container.innerHTML = `<p class="text-red-400">Network error.</p>`;
  }
};
