// Post types and the list card, shared by the home page and /posts. Both are
// fed by the same backend `PostSummary`, so the shape lives here once.

import { esc, fmtDate, CARD_LIFT_CLASS } from "./helpers";

export type PostType = "article" | "book_review";

// The full review, as returned by /posts/{slug}. Summaries carry only the
// card fields (book_title, author, rating, cover_url); the rest arrive null.
export type BookReview = {
  book_title: string;
  author: string;
  rating: number | null;
  cover_url: string | null;
  isbn: string | null;
  read_date: string | null;
  link: string | null;
};

export type PostSummary = {
  slug: string;
  title: string;
  excerpt: string;
  published_at: string | null;
  post_type: PostType;
  book_review?: BookReview;
};

export type Post = {
  slug: string;
  title: string;
  body: string;
  published_at: string | null;
  post_type: PostType;
  book_review?: BookReview;
};

// A ★★★☆☆ rating out of 5, or empty for an unrated review.
export const stars = (rating: number | null | undefined): string => {
  if (!rating) return "";
  const n = Math.max(0, Math.min(5, rating));
  return `<span class="text-yellow-500" aria-label="${n} out of 5">${"★".repeat(n)}<span class="text-green-900">${"★".repeat(5 - n)}</span></span>`;
};

// The card is the same everywhere; only its chrome differs. On the home page it
// sits under an <h2> section heading and gets the lift-on-hover treatment used
// by the project cards; on /posts it sits under the <h1> and stays flat.
type Variant = { heading: "h2" | "h3"; cover: string; link: string };

const VARIANTS: Record<"home" | "list", Variant> = {
  home: {
    heading: "h3",
    cover: "w-14 h-20",
    link: `group hover:bg-stone-800 cursor-pointer ${CARD_LIFT_CLASS}`,
  },
  list: {
    heading: "h2",
    cover: "w-16 h-24",
    link: "hover:border-green-700 transition-colors",
  },
};

export const postCard = (
  p: PostSummary,
  variant: keyof typeof VARIANTS = "list",
): string => {
  const v = VARIANTS[variant];
  const br = p.post_type === "book_review" ? p.book_review : undefined;
  const cover = br?.cover_url
    ? `<img src="${esc(br.cover_url)}" alt="" loading="lazy"
           class="shrink-0 ${v.cover} object-cover border border-green-900 bg-stone-950" />`
    : "";
  const meta = br
    ? `<div class="flex items-center gap-2 text-xs text-green-700 mt-1">
         ${br.author ? `<span>${esc(br.author)}</span>` : ""}${stars(br.rating)}
       </div>`
    : "";
  return `
    <a href="/posts/${esc(p.slug)}" class="flex gap-4 border border-green-900 bg-stone-900 p-5 ${v.link}">
      ${cover}
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline justify-between gap-4">
          <${v.heading} class="text-lg font-bold text-lime-300 transition-colors group-hover:text-lime-200">${esc(p.title)}</${v.heading}>
          <span class="text-green-700 text-sm whitespace-nowrap">${fmtDate(p.published_at)}</span>
        </div>
        ${meta}
        <p class="text-sm text-stone-400 leading-relaxed mt-2">${esc(p.excerpt)}</p>
      </div>
    </a>`;
};
