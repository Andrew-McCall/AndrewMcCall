// Admin editor for the home page profile: intro markdown, image and GitHub
// link. Router gates this to admins.

import { api, errorText, jsonInit } from "./helpers";
import { renderMarkdown } from "./markdown";

type Profile = {
  intro_markdown: string;
  profile_image_url: string;
  github_url: string;
};

export default async (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <div class="w-full max-w-3xl">
    <a href="/secret/admin" title="Back to admin">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Profile
      </h1>
    </a>
  </div>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <label class="text-green-600 font-mono text-sm uppercase tracking-widest">Intro (markdown)</label>
    <textarea id="intro" rows="10" spellcheck="false" placeholder="who are you?"
      class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm resize-y"></textarea>

    <label class="text-green-600 font-mono text-sm uppercase tracking-widest mt-4">Profile image URL</label>
    <input id="image-url" type="text" spellcheck="false" autocomplete="off" placeholder="/profile.jpg or https://…"
      class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />

    <label class="text-green-600 font-mono text-sm uppercase tracking-widest mt-4">GitHub URL</label>
    <input id="github-url" type="text" spellcheck="false" autocomplete="off" placeholder="https://github.com/…"
      class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />

    <div class="flex items-center gap-4 mt-4">
      <button id="save-btn" class="bg-green-700 hover:bg-green-600 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold px-5 py-2 rounded cursor-pointer transition-colors">Save</button>
      <button id="preview-btn" class="text-green-600 hover:text-green-400 cursor-pointer text-sm">preview</button>
      <span id="status" class="text-green-700 text-sm"></span>
    </div>
    <div id="preview" class="hidden flex-col gap-3 text-stone-300 border border-green-900 rounded p-4 select-text"></div>
  </div>
</div>`;

  const intro = app.querySelector<HTMLTextAreaElement>("#intro")!;
  const imageUrl = app.querySelector<HTMLInputElement>("#image-url")!;
  const githubUrl = app.querySelector<HTMLInputElement>("#github-url")!;
  const saveBtn = app.querySelector<HTMLButtonElement>("#save-btn")!;
  const previewBtn = app.querySelector<HTMLButtonElement>("#preview-btn")!;
  const preview = app.querySelector<HTMLDivElement>("#preview")!;
  const status = app.querySelector<HTMLSpanElement>("#status")!;

  try {
    const res = await api("/admin/profile");
    if (res.ok) {
      const profile: Profile = await res.json();
      intro.value = profile.intro_markdown;
      imageUrl.value = profile.profile_image_url;
      githubUrl.value = profile.github_url;
    } else {
      status.textContent = await errorText(res);
    }
  } catch {
    status.textContent = "Network error.";
  }

  previewBtn.onclick = () => {
    const hidden = preview.classList.toggle("hidden");
    preview.classList.toggle("flex", !hidden);
    if (!hidden) preview.innerHTML = renderMarkdown(intro.value);
  };

  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    status.textContent = "";
    try {
      const res = await api(
        "/admin/profile",
        jsonInit(
          {
            intro_markdown: intro.value,
            profile_image_url: imageUrl.value.trim(),
            github_url: githubUrl.value.trim(),
          },
          "PUT",
        ),
      );
      status.textContent = res.ok ? "saved" : await errorText(res);
    } catch {
      status.textContent = "Network error.";
    } finally {
      saveBtn.disabled = false;
    }
  };
};
