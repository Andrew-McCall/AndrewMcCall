// Admin editor for the home page's pinned projects. Router gates this to admins.

import { api, esc, errorText, jsonInit } from "./helpers";

type Project = {
  id: string;
  name: string;
  description: string;
  url: string | null;
  repo: string | null;
  sort_order: number;
};

export default async (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <div class="w-full max-w-3xl">
    <a href="/secret/admin" title="Back to admin">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Projects
      </h1>
    </a>
  </div>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Pinned projects</h2>
    <div id="project-list" class="flex flex-col gap-4"></div>
    <button id="add-btn" class="self-start bg-transparent border border-green-500 hover:bg-green-500/10 text-green-400 font-bold px-5 py-2 cursor-pointer transition-colors mt-2">Add project</button>
  </div>
</div>`;

  const list = app.querySelector<HTMLDivElement>("#project-list")!;

  let projects: Project[] = [];

  const field = (
    id: string,
    placeholder: string,
    value: string,
    extra = "",
  ) => `
    <input data-field="${id}" type="text" placeholder="${placeholder}" value="${esc(value)}" spellcheck="false" autocomplete="off"
      class="bg-stone-950 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm ${extra}" />`;

  const card = (project: Project | null): HTMLDivElement => {
    const div = document.createElement("div");
    div.className = "bg-stone-900 border border-green-900 p-4 flex flex-col gap-2";
    div.innerHTML = `
      <div class="flex gap-2">
        ${field("name", "name", project?.name ?? "", "flex-1")}
        ${field("sort_order", "order", String(project?.sort_order ?? 0), "w-20")}
      </div>
      ${field("description", "description", project?.description ?? "")}
      <div class="flex gap-2">
        ${field("url", "https://…", project?.url ?? "", "flex-1")}
        ${field("repo", "owner/name", project?.repo ?? "", "flex-1")}
      </div>
      <div class="flex gap-4 text-sm">
        <button data-action="save" class="bg-transparent border border-green-500 hover:bg-green-500/10 disabled:opacity-60 text-green-400 font-bold px-4 py-1.5 cursor-pointer transition-colors">Save</button>
        ${project ? `<button data-action="delete" class="text-red-500 hover:text-red-400 cursor-pointer ml-auto">delete</button>` : ""}
      </div>`;

    const value = (name: string) =>
      div.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!.value.trim();
    const saveBtn = div.querySelector<HTMLButtonElement>('[data-action="save"]')!;

    saveBtn.onclick = async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      const payload = {
        name: value("name"),
        description: value("description"),
        url: value("url"),
        repo: value("repo"),
        sort_order: parseInt(value("sort_order"), 10) || 0,
      };
      try {
        const res = project
          ? await api(`/admin/projects/${project.id}`, jsonInit(payload, "PUT"))
          : await api("/admin/projects", jsonInit(payload));
        if (!res.ok) {
          alert(await errorText(res));
          return;
        }
        await load();
      } catch {
        alert("Network error.");
      } finally {
        saveBtn.disabled = false;
      }
    };

    div.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener(
      "click",
      async () => {
        if (!project || !confirm(`Delete ${project.name}?`)) return;
        try {
          const res = await api(`/admin/projects/${project.id}`, { method: "DELETE" });
          if (!res.ok) {
            alert(await errorText(res));
            return;
          }
          await load();
        } catch {
          alert("Network error.");
        }
      },
    );

    return div;
  };

  const render = () => {
    list.innerHTML = projects.length
      ? ""
      : `<p class="text-green-700 text-sm">no projects yet</p>`;
    for (const project of projects) list.appendChild(card(project));
  };

  const load = async () => {
    try {
      const res = await api("/admin/projects");
      if (!res.ok) {
        list.innerHTML = `<p class="text-red-400 text-sm">${await errorText(res)}</p>`;
        return;
      }
      projects = await res.json();
      render();
    } catch {
      list.innerHTML = `<p class="text-red-400 text-sm">Network error.</p>`;
    }
  };

  app.querySelector<HTMLButtonElement>("#add-btn")!.onclick = () => {
    if (list.firstElementChild?.textContent?.includes("no projects")) list.innerHTML = "";
    list.appendChild(card(null));
  };

  await load();
};
