// Admin page. Every call uses `credentials: "include"` so the HttpOnly session
// cookie set at login is sent along. The router gates this route — only a
// signed-in admin reaches here, and it passes the resolved user in as `me`.
// Admins get: the user
// list (with a create form and per-row delete) and a 2FA panel for their own
// account (enrol via `/auth/totp/setup` → `/auth/totp/enable`, or disable).

import type { Me } from "./session.ts";

type AdminUser = {
  id: string;
  name: string;
  role: string;
  totp_enabled: boolean;
  created_at: string;
  last_login: string | null;
};

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Reads `{ error }` from a non-2xx JSON body, falling back to the status.
const errorText = async (res: Response): Promise<string> => {
  const body = await res.json().catch(() => null);
  if (body && typeof body.error === "string") return body.error;
  return `Error ${res.status}`;
};

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : "—";

export default async (app: HTMLElement, me: Me) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <div class="w-full max-w-3xl flex items-center justify-between">
    <a href="/secret" title="Back to the secret menu">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Admin
      </h1>
    </a>
    <div class="flex items-center gap-4 text-sm text-green-700">
      <a href="/secret/admin/visits" class="hover:text-green-400">visits</a>
      <span>signed in as <span class="text-green-400">${me.name}</span></span>
      <button id="logout" class="hover:text-green-400 cursor-pointer">log out</button>
    </div>
  </div>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Create user</h2>
    <form id="create-form" class="flex flex-col sm:flex-row gap-2">
      <input id="new-name" type="text" placeholder="name" spellcheck="false" autocomplete="off"
        class="flex-1 bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono" />
      <input id="new-pin" type="text" inputmode="numeric" placeholder="pin" autocomplete="off"
        class="w-32 bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono" />
      <select id="new-role"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono">
        <option value="standard">standard</option>
        <option value="admin">admin</option>
      </select>
      <button type="submit"
        class="bg-green-700 hover:bg-green-600 active:bg-green-800 text-white font-bold px-5 py-2 rounded cursor-pointer transition-colors">
        Create
      </button>
    </form>
  </div>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Users</h2>
    <div class="overflow-x-auto">
      <table class="w-full text-left font-mono text-sm">
        <thead class="text-green-700 border-b border-green-900">
          <tr>
            <th class="py-2 pr-4">Name</th>
            <th class="py-2 pr-4">Role</th>
            <th class="py-2 pr-4">2FA</th>
            <th class="py-2 pr-4">Last seen</th>
            <th class="py-2"></th>
          </tr>
        </thead>
        <tbody id="user-rows" class="text-green-300"></tbody>
      </table>
    </div>
  </div>

  <div class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Your two-factor auth</h2>
    <div id="totp-panel" class="bg-stone-900 border border-green-900 rounded px-4 py-4 text-sm"></div>
  </div>
</div>`;

  const rows = app.querySelector<HTMLTableSectionElement>("#user-rows")!;
  const totpPanel = app.querySelector<HTMLDivElement>("#totp-panel")!;

  // --- user list -----------------------------------------------------------
  const renderUsers = (users: AdminUser[]) => {
    rows.innerHTML = "";
    for (const user of users) {
      const tr = document.createElement("tr");
      tr.className = "border-b border-green-900/40";
      const isSelf = user.id === me.id;
      tr.innerHTML = `
        <td class="py-2 pr-4">${user.name}${isSelf ? " <span class='text-green-700'>(you)</span>" : ""}</td>
        <td class="py-2 pr-4">${user.role}</td>
        <td class="py-2 pr-4">${user.totp_enabled ? "on" : "off"}</td>
        <td class="py-2 pr-4 text-green-700">${fmtDate(user.last_login)}</td>
        <td class="py-2 text-right"></td>`;
      const actionCell = tr.querySelector("td:last-child")!;
      if (!isSelf) {
        const del = document.createElement("button");
        del.textContent = "delete";
        del.className = "text-red-500 hover:text-red-400 cursor-pointer";
        del.onclick = () => deleteUser(user);
        actionCell.appendChild(del);
      }
      rows.appendChild(tr);
    }
  };

  const loadUsers = async () => {
    try {
      const res = await api("/admin/users");
      if (!res.ok) {
        rows.innerHTML = `<tr><td colspan="5" class="py-3 text-red-400">${await errorText(res)}</td></tr>`;
        return;
      }
      renderUsers(await res.json());
    } catch {
      rows.innerHTML = `<tr><td colspan="5" class="py-3 text-red-400">Network error.</td></tr>`;
    }
  };

  const deleteUser = async (user: AdminUser) => {
    if (!confirm(`Delete ${user.name}? This cannot be undone.`)) return;
    try {
      const res = await api(`/admin/users/${user.id}`, { method: "DELETE" });
      if (res.ok) {
        await loadUsers();
      } else {
        alert(await errorText(res));
      }
    } catch {
      alert("Network error.");
    }
  };

  // --- create user ---------------------------------------------------------
  const createForm = app.querySelector<HTMLFormElement>("#create-form")!;
  const newName = app.querySelector<HTMLInputElement>("#new-name")!;
  const newPin = app.querySelector<HTMLInputElement>("#new-pin")!;
  const newRole = app.querySelector<HTMLSelectElement>("#new-role")!;

  createForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = newName.value.trim();
    const pin = newPin.value.trim();
    if (!name || !pin) return;
    try {
      const res = await api(
        "/admin/users",
        jsonInit({ name, pin, role: newRole.value }),
      );
      if (res.ok) {
        newName.value = "";
        newPin.value = "";
        await loadUsers();
      } else {
        alert(await errorText(res));
      }
    } catch {
      alert("Network error.");
    }
  });

  // --- 2FA panel -----------------------------------------------------------
  const renderTotpPanel = () => {
    if (me.totp_enabled) {
      totpPanel.innerHTML = `
        <p class="text-green-400 mb-3">Two-factor authentication is <span class="text-green-300 font-bold">on</span>.</p>
        <div class="flex gap-2">
          <input id="disable-code" type="text" placeholder="current or recovery code" autocomplete="off"
            class="flex-1 bg-stone-950 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono" />
          <button id="disable-btn" class="bg-red-800 hover:bg-red-700 text-white px-4 py-2 rounded cursor-pointer">Disable</button>
        </div>`;
      totpPanel.querySelector<HTMLButtonElement>("#disable-btn")!.onclick = disableTotp;
    } else {
      totpPanel.innerHTML = `
        <p class="text-green-700 mb-3">Two-factor authentication is off.</p>
        <button id="setup-btn" class="bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded cursor-pointer">Enable 2FA</button>`;
      totpPanel.querySelector<HTMLButtonElement>("#setup-btn")!.onclick = startTotpSetup;
    }
  };

  const startTotpSetup = async () => {
    try {
      const res = await api("/auth/totp/setup", { method: "POST" });
      if (!res.ok) return alert(await errorText(res));
      const { secret_base32, otpauth_uri } = await res.json();
      totpPanel.innerHTML = `
        <p class="text-green-400 mb-2">Add this secret to your authenticator app, then enter the code it shows.</p>
        <p class="mb-1 text-green-700">Secret</p>
        <code class="block break-all text-green-300 mb-2">${secret_base32}</code>
        <a href="${otpauth_uri}" class="text-green-600 hover:text-green-400 text-xs break-all block mb-3">${otpauth_uri}</a>
        <div class="flex gap-2">
          <input id="enable-code" type="text" inputmode="numeric" placeholder="6-digit code" autocomplete="one-time-code"
            class="flex-1 bg-stone-950 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono" />
          <button id="enable-btn" class="bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded cursor-pointer">Confirm</button>
        </div>`;
      const codeEl = totpPanel.querySelector<HTMLInputElement>("#enable-code")!;
      totpPanel.querySelector<HTMLButtonElement>("#enable-btn")!.onclick = () =>
        enableTotp(secret_base32, codeEl.value.trim());
    } catch {
      alert("Network error.");
    }
  };

  const enableTotp = async (secret: string, code: string) => {
    if (!code) return;
    try {
      const res = await api("/auth/totp/enable", jsonInit({ secret, code }));
      if (!res.ok) return alert(await errorText(res));
      const { recovery_codes } = await res.json();
      me.totp_enabled = true;
      totpPanel.innerHTML = `
        <p class="text-green-400 mb-2 font-bold">2FA enabled. Save these recovery codes now — they won't be shown again.</p>
        <div class="grid grid-cols-2 gap-1 font-mono text-green-300 mb-3">
          ${(recovery_codes as string[]).map((c) => `<code>${c}</code>`).join("")}
        </div>
        <button id="totp-done" class="bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded cursor-pointer">Done</button>`;
      totpPanel.querySelector<HTMLButtonElement>("#totp-done")!.onclick = renderTotpPanel;
    } catch {
      alert("Network error.");
    }
  };

  const disableTotp = async () => {
    const code = totpPanel.querySelector<HTMLInputElement>("#disable-code")!.value.trim();
    if (!code) return;
    try {
      const res = await api("/auth/totp/disable", jsonInit({ code }));
      if (!res.ok) return alert(await errorText(res));
      me.totp_enabled = false;
      renderTotpPanel();
    } catch {
      alert("Network error.");
    }
  };

  // --- log out -------------------------------------------------------------
  app.querySelector<HTMLButtonElement>("#logout")!.onclick = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* clearing the cookie server-side is best-effort */
    }
    window.navigate("/secret");
  };

  renderTotpPanel();
  await loadUsers();
};
