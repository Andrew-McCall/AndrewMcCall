// Admin blog editor: list of all posts (drafts included) beside a markdown
// editor with live preview. Router gates this to admins.

import { api, esc, errorText, fmtDate, jsonInit } from "./helpers";
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

type Post = {
  id: string;
  slug: string;
  title: string;
  body: string;
  is_published: boolean;
  published_at: string | null;
  updated_at: string;
  post_type: PostType;
  book_review?: BookReview;
};

export default async (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <div class="w-full max-w-5xl flex items-center justify-between">
    <a href="/secret/admin" title="Back to admin">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Posts
      </h1>
    </a>
    <button id="new-post" class="bg-transparent border border-green-500 hover:bg-green-500/10 text-green-400 font-bold px-5 py-2 cursor-pointer transition-colors">New post</button>
  </div>

  <div class="w-full max-w-5xl mt-8 grid md:grid-cols-[16rem_1fr] gap-6">
    <div id="post-list" class="flex flex-col gap-1 md:border-r md:border-green-900 md:pr-4"></div>
    <div id="editor" class="hidden flex-col gap-3">
      <select id="edit-type"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 font-mono text-sm cursor-pointer">
        <option value="article">Article</option>
        <option value="book_review">Book review</option>
      </select>
      <fieldset id="br-fields" class="hidden flex-col gap-2 border border-green-900 p-3">
        <legend class="text-green-600 text-xs px-1">book review</legend>
        <input id="br-book-title" type="text" placeholder="book title" spellcheck="false"
          class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
        <input id="br-author" type="text" placeholder="author" spellcheck="false"
          class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
        <div class="grid grid-cols-2 gap-2">
          <input id="br-rating" type="number" min="1" max="5" placeholder="rating 1–5"
            class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
          <input id="br-read-date" type="date" placeholder="read date"
            class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
        </div>
        <input id="br-cover-url" type="text" placeholder="cover image URL" spellcheck="false" autocomplete="off"
          class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
        <div class="grid grid-cols-2 gap-2">
          <input id="br-isbn" type="text" placeholder="ISBN" spellcheck="false" autocomplete="off"
            class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
          <input id="br-link" type="text" placeholder="link (Goodreads, etc.)" spellcheck="false" autocomplete="off"
            class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
        </div>
      </fieldset>
      <input id="edit-title" type="text" placeholder="title" spellcheck="false"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono" />
      <input id="edit-slug" type="text" placeholder="slug (blank = from title)" spellcheck="false" autocomplete="off"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
      <textarea id="edit-body" rows="16" placeholder="markdown…" spellcheck="false"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm resize-y"></textarea>
      <div class="flex items-center gap-4 flex-wrap">
        <label class="flex items-center gap-2 text-sm text-green-400 cursor-pointer">
          <input id="edit-published" type="checkbox" class="accent-green-600" /> published
        </label>
        <button id="save-btn" class="bg-transparent border border-green-500 hover:bg-green-500/10 disabled:opacity-60 disabled:cursor-not-allowed text-green-400 font-bold px-5 py-2 cursor-pointer transition-colors">Save</button>
        <button id="preview-btn" class="text-green-600 hover:text-green-400 cursor-pointer text-sm">preview</button>
        <button id="delete-btn" class="hidden text-red-500 hover:text-red-400 cursor-pointer text-sm ml-auto">delete</button>
      </div>
      <div id="preview" class="hidden flex-col gap-3 text-stone-300 border border-green-900 p-4"></div>
    </div>
  </div>
</div>`;

  const list = app.querySelector<HTMLDivElement>("#post-list")!;
  const editor = app.querySelector<HTMLDivElement>("#editor")!;
  const titleEl = app.querySelector<HTMLInputElement>("#edit-title")!;
  const slugEl = app.querySelector<HTMLInputElement>("#edit-slug")!;
  const bodyEl = app.querySelector<HTMLTextAreaElement>("#edit-body")!;
  const publishedEl = app.querySelector<HTMLInputElement>("#edit-published")!;
  const typeEl = app.querySelector<HTMLSelectElement>("#edit-type")!;
  const brFields = app.querySelector<HTMLFieldSetElement>("#br-fields")!;
  const brBookTitle = app.querySelector<HTMLInputElement>("#br-book-title")!;
  const brAuthor = app.querySelector<HTMLInputElement>("#br-author")!;
  const brRating = app.querySelector<HTMLInputElement>("#br-rating")!;
  const brReadDate = app.querySelector<HTMLInputElement>("#br-read-date")!;
  const brCoverUrl = app.querySelector<HTMLInputElement>("#br-cover-url")!;
  const brIsbn = app.querySelector<HTMLInputElement>("#br-isbn")!;
  const brLink = app.querySelector<HTMLInputElement>("#br-link")!;

  // Book-review fields show only for the book_review type.
  const syncType = () => {
    const isReview = typeEl.value === "book_review";
    brFields.classList.toggle("hidden", !isReview);
    brFields.classList.toggle("flex", isReview);
  };
  typeEl.onchange = syncType;
  const saveBtn = app.querySelector<HTMLButtonElement>("#save-btn")!;
  const previewBtn = app.querySelector<HTMLButtonElement>("#preview-btn")!;
  const deleteBtn = app.querySelector<HTMLButtonElement>("#delete-btn")!;
  const preview = app.querySelector<HTMLDivElement>("#preview")!;

  let posts: Post[] = [];
  let current: Post | null = null;

  const renderList = () => {
    list.innerHTML = posts.length
      ? ""
      : `<p class="text-green-700 text-sm">no posts yet</p>`;
    for (const post of posts) {
      const btn = document.createElement("button");
      btn.className = `text-left px-2 py-1.5 cursor-pointer text-sm hover:bg-stone-900 ${
        current?.id === post.id ? "bg-stone-900 text-green-300" : "text-green-500"
      }`;
      btn.innerHTML = `${esc(post.title || "(untitled)")}${
        post.is_published
          ? `<span class="text-green-800 block text-xs">${fmtDate(post.published_at)}</span>`
          : `<span class="text-yellow-700 block text-xs">draft</span>`
      }`;
      btn.onclick = () => openPost(post);
      list.appendChild(btn);
    }
  };

  const openPost = (post: Post | null) => {
    current = post;
    editor.classList.remove("hidden");
    editor.classList.add("flex");
    preview.classList.add("hidden");
    titleEl.value = post?.title ?? "";
    slugEl.value = post?.slug ?? "";
    bodyEl.value = post?.body ?? "";
    publishedEl.checked = post?.is_published ?? false;
    typeEl.value = post?.post_type ?? "article";
    const br = post?.book_review;
    brBookTitle.value = br?.book_title ?? "";
    brAuthor.value = br?.author ?? "";
    brRating.value = br?.rating != null ? String(br.rating) : "";
    brReadDate.value = br?.read_date ? br.read_date.slice(0, 10) : "";
    brCoverUrl.value = br?.cover_url ?? "";
    brIsbn.value = br?.isbn ?? "";
    brLink.value = br?.link ?? "";
    syncType();
    deleteBtn.classList.toggle("hidden", !post);
    renderList();
    titleEl.focus();
  };

  const load = async () => {
    try {
      const res = await api("/admin/posts");
      if (!res.ok) {
        list.innerHTML = `<p class="text-red-400 text-sm">${await errorText(res)}</p>`;
        return;
      }
      posts = await res.json();
      renderList();
    } catch {
      list.innerHTML = `<p class="text-red-400 text-sm">Network error.</p>`;
    }
  };

  app.querySelector<HTMLButtonElement>("#new-post")!.onclick = () => openPost(null);

  previewBtn.onclick = () => {
    const hidden = preview.classList.toggle("hidden");
    preview.classList.toggle("flex", !hidden);
    if (!hidden) preview.innerHTML = renderMarkdown(bodyEl.value);
  };

  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    const postType: PostType =
      typeEl.value === "book_review" ? "book_review" : "article";
    const trimOrNull = (v: string) => {
      const t = v.trim();
      return t === "" ? null : t;
    };
    const payload = {
      slug: slugEl.value.trim(),
      title: titleEl.value.trim(),
      body: bodyEl.value,
      is_published: publishedEl.checked,
      post_type: postType,
      book_review:
        postType === "book_review"
          ? {
              book_title: brBookTitle.value.trim(),
              author: brAuthor.value.trim(),
              rating: brRating.value ? Number(brRating.value) : null,
              cover_url: trimOrNull(brCoverUrl.value),
              isbn: trimOrNull(brIsbn.value),
              read_date: trimOrNull(brReadDate.value),
              link: trimOrNull(brLink.value),
            }
          : null,
    };
    try {
      const res = current
        ? await api(`/admin/posts/${current.id}`, jsonInit(payload, "PUT"))
        : await api("/admin/posts", jsonInit(payload));
      if (!res.ok) {
        alert(await errorText(res));
        return;
      }
      const saved: Post = await res.json();
      await load();
      openPost(posts.find((p) => p.id === saved.id) ?? saved);
    } catch {
      alert("Network error.");
    } finally {
      saveBtn.disabled = false;
    }
  };

  deleteBtn.onclick = async () => {
    if (!current) return;
    if (!confirm(`Delete "${current.title || current.slug}"?`)) return;
    try {
      const res = await api(`/admin/posts/${current.id}`, { method: "DELETE" });
      if (!res.ok) {
        alert(await errorText(res));
        return;
      }
      editor.classList.add("hidden");
      editor.classList.remove("flex");
      current = null;
      await load();
    } catch {
      alert("Network error.");
    }
  };

  await load();
};
