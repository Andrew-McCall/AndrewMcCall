// Admin editor for the home page's "Now" details. The set of details is a fixed
// whitelist (labels come from the server); this page just edits each detail's
// value and optional link, saving the whole set in one PUT. Router gates to admins.

import { PAGE_CLASS, api, esc, errorText, jsonInit } from "./helpers";

import type { Detail } from "@andrewmccall/api-types";

export default async (app: HTMLElement) => {
  app.innerHTML = `
<div class="${PAGE_CLASS}">
  <div class="w-full max-w-3xl">
    <a href="/secret/admin" title="Back to admin">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Now
      </h1>
    </a>
  </div>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Home-page details</h2>
    <p class="text-green-700 text-sm">Leave a value blank to hide that detail from the home page.</p>
    <div id="detail-list" class="flex flex-col gap-4"></div>
    <div class="flex items-center gap-4 mt-2">
      <button id="save-btn" class="bg-transparent border border-green-500 hover:bg-green-500/10 disabled:opacity-60 disabled:cursor-not-allowed text-green-400 font-bold px-5 py-2 cursor-pointer transition-colors">Save</button>
      <span id="status" class="text-green-700 text-sm"></span>
    </div>
  </div>
</div>`;

  const list = app.querySelector<HTMLDivElement>("#detail-list")!;
  const saveBtn = app.querySelector<HTMLButtonElement>("#save-btn")!;
  const status = app.querySelector<HTMLSpanElement>("#status")!;

  const field = (id: string, placeholder: string, value: string) => `
    <input data-field="${id}" type="text" placeholder="${placeholder}" value="${esc(value)}" spellcheck="false" autocomplete="off"
      class="bg-stone-950 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />`;

  const render = (details: Detail[]) => {
    list.innerHTML = "";
    for (const detail of details) {
      const div = document.createElement("div");
      div.className = "bg-stone-900 border border-green-900 p-4 flex flex-col gap-2";
      div.dataset.key = detail.key;
      div.innerHTML = `
        <label class="text-green-600 font-mono text-sm">${esc(detail.label)}</label>
        ${field("value", "value", detail.value)}
        ${field("url", "https://… (optional link)", detail.url ?? "")}`;
      list.appendChild(div);
    }
  };

  const load = async () => {
    try {
      const res = await api("/admin/details");
      if (!res.ok) {
        list.innerHTML = `<p class="text-red-400 text-sm">${await errorText(res)}</p>`;
        return;
      }
      render(await res.json());
    } catch {
      list.innerHTML = `<p class="text-red-400 text-sm">Network error.</p>`;
    }
  };

  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    status.textContent = "";
    const payload = [...list.children].map((card) => {
      const el = card as HTMLElement;
      const value = (name: string) =>
        el.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!.value.trim();
      return { key: el.dataset.key!, value: value("value"), url: value("url") };
    });
    try {
      const res = await api("/admin/details", jsonInit(payload, "PUT"));
      if (res.ok) {
        render(await res.json());
        status.textContent = "saved";
      } else {
        status.textContent = await errorText(res);
      }
    } catch {
      status.textContent = "Network error.";
    } finally {
      saveBtn.disabled = false;
    }
  };

  await load();
};
