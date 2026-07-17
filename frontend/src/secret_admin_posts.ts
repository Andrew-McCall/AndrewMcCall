// Admin blog editor: list of all posts (drafts included) beside a markdown
// editor with live preview. Router gates this to admins.

import { api, esc, errorText, fmtDate, jsonInit } from "./helpers";
import { renderMarkdown } from "./markdown";

type Post = {
  id: string;
  slug: string;
  title: string;
  body: string;
  is_published: boolean;
  published_at: string | null;
  updated_at: string;
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
    <button id="new-post" class="bg-green-700 hover:bg-green-600 text-white font-bold px-5 py-2 rounded cursor-pointer transition-colors">New post</button>
  </div>

  <div class="w-full max-w-5xl mt-8 grid md:grid-cols-[16rem_1fr] gap-6">
    <div id="post-list" class="flex flex-col gap-1 md:border-r md:border-green-900 md:pr-4"></div>
    <div id="editor" class="hidden flex-col gap-3">
      <input id="edit-title" type="text" placeholder="title" spellcheck="false"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono" />
      <input id="edit-slug" type="text" placeholder="slug (blank = from title)" spellcheck="false" autocomplete="off"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
      <textarea id="edit-body" rows="16" placeholder="markdown…" spellcheck="false"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm resize-y"></textarea>
      <div class="flex items-center gap-4 flex-wrap">
        <label class="flex items-center gap-2 text-sm text-green-400 cursor-pointer">
          <input id="edit-published" type="checkbox" class="accent-green-600" /> published
        </label>
        <button id="save-btn" class="bg-green-700 hover:bg-green-600 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold px-5 py-2 rounded cursor-pointer transition-colors">Save</button>
        <button id="preview-btn" class="text-green-600 hover:text-green-400 cursor-pointer text-sm">preview</button>
        <button id="delete-btn" class="hidden text-red-500 hover:text-red-400 cursor-pointer text-sm ml-auto">delete</button>
      </div>
      <div id="preview" class="hidden flex-col gap-3 text-stone-300 border border-green-900 rounded p-4 select-text"></div>
    </div>
  </div>
</div>`;

  const list = app.querySelector<HTMLDivElement>("#post-list")!;
  const editor = app.querySelector<HTMLDivElement>("#editor")!;
  const titleEl = app.querySelector<HTMLInputElement>("#edit-title")!;
  const slugEl = app.querySelector<HTMLInputElement>("#edit-slug")!;
  const bodyEl = app.querySelector<HTMLTextAreaElement>("#edit-body")!;
  const publishedEl = app.querySelector<HTMLInputElement>("#edit-published")!;
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
      btn.className = `text-left px-2 py-1.5 rounded cursor-pointer text-sm hover:bg-stone-900 ${
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
    const payload = {
      slug: slugEl.value.trim(),
      title: titleEl.value.trim(),
      body: bodyEl.value,
      is_published: publishedEl.checked,
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
