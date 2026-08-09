// Admin page. Every call uses `credentials: "include"` so the HttpOnly session
// cookie set at login is sent along. The router gates this route — only a
// signed-in admin reaches here, and it passes the resolved user in as `me`.
// Admins get: the user list (with a create form and per-row delete) and a 2FA
// panel for their own account (enrol via `/auth/totp/setup` → `/auth/totp/enable`,
// or disable).

import type { Me } from "./session.ts";
import { PAGE_CLASS, api, esc, errorText, jsonInit, setMeta } from "./helpers";

type AdminUser = {
  id: string;
  name: string;
  role: string;
  totp_enabled: boolean;
  created_at: string;
  last_login: string | null;
};

// Dates here are audit data, so unlike the public pages' `fmtDate` these keep
// the time of day.
const fmtDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : "—";

// Shared chrome, so the buttons on this page stay in step with each other.
const RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";
const BTN =
  `bg-transparent border border-green-500 hover:bg-green-500/10 active:bg-green-500/20 ` +
  `disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent ` +
  `text-green-400 px-4 py-2 cursor-pointer transition-colors focus-visible:ring-green-500 ${RING}`;
const BTN_DANGER =
  `bg-transparent border border-red-500 hover:bg-red-500/10 active:bg-red-500/20 ` +
  `disabled:opacity-50 disabled:cursor-not-allowed text-red-400 px-4 py-2 cursor-pointer ` +
  `transition-colors focus-visible:ring-red-500 ${RING}`;
const BTN_QUIET =
  `text-green-700 hover:text-green-400 cursor-pointer transition-colors focus-visible:ring-green-500 ${RING}`;
const INPUT =
  "bg-stone-950 border border-green-900 focus:border-green-600 outline-none px-3 py-2 " +
  "text-green-300 placeholder-green-900 font-mono transition-colors";
const NAV_LINK =
  `px-2 py-1 border border-transparent hover:border-green-900 hover:text-green-400 ` +
  `text-green-700 transition-colors focus-visible:ring-green-500 ${RING}`;

const NAV: [string, string][] = [
  ["/secret/admin/visits", "visits"],
  ["/secret/admin/posts", "posts"],
  ["/secret/admin/projects", "projects"],
  ["/secret/admin/details", "now"],
  ["/secret/admin/profile", "profile"],
  ["/secret/account", "account"],
];

export default async (app: HTMLElement, me: Me) => {
  setMeta("Admin", "Site administration.");

  app.innerHTML = `
<div class="${PAGE_CLASS}">
  <header class="w-full max-w-3xl flex flex-col gap-4">
    <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <a href="/secret" title="Back to the secret menu" class="${RING} focus-visible:ring-green-500">
        <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
          Admin
        </h1>
      </a>
      <p class="font-mono text-sm text-green-700">
        signed in as <span class="text-green-400">${esc(me.name)}</span>
        <span aria-hidden="true" class="px-1 text-green-900">/</span>
        <button id="logout" class="${BTN_QUIET} underline underline-offset-2">log out</button>
      </p>
    </div>
    <nav aria-label="Admin sections" class="flex flex-wrap gap-1 font-mono text-sm border-y border-green-900/60 py-2">
      ${NAV.map(([href, label]) => `<a href="${href}" class="${NAV_LINK}">${label}</a>`).join("")}
    </nav>
  </header>

  <section class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Create user</h2>
    <form id="create-form" novalidate class="flex flex-col sm:flex-row gap-2">
      <label class="sr-only" for="new-name">Name</label>
      <input id="new-name" name="name" type="text" placeholder="name" spellcheck="false" autocomplete="off"
        class="${INPUT} flex-1" />
      <label class="sr-only" for="new-pin">PIN</label>
      <input id="new-pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="pin" autocomplete="new-password"
        class="${INPUT} w-full sm:w-32" />
      <label class="sr-only" for="new-role">Role</label>
      <select id="new-role" name="role" class="${INPUT}">
        <option value="standard">standard</option>
        <option value="admin">admin</option>
      </select>
      <button id="create-submit" type="submit" class="${BTN} font-bold px-5">Create</button>
    </form>
    <p id="create-status" role="status" aria-live="polite" class="font-mono text-sm min-h-5"></p>
  </section>

  <section class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <div class="flex items-baseline justify-between gap-4">
      <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Users</h2>
      <span id="user-count" class="font-mono text-sm text-green-800"></span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-left font-mono text-sm">
        <thead class="text-green-700 border-b border-green-900">
          <tr>
            <th scope="col" class="py-2 pr-4 font-normal">Name</th>
            <th scope="col" class="py-2 pr-4 font-normal">Role</th>
            <th scope="col" class="py-2 pr-4 font-normal">2FA</th>
            <th scope="col" class="py-2 pr-4 font-normal">Created</th>
            <th scope="col" class="py-2 pr-4 font-normal">Last seen</th>
            <th scope="col" class="py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody id="user-rows" aria-live="polite" aria-busy="true" class="text-green-300"></tbody>
      </table>
    </div>
  </section>

  <section class="w-full max-w-3xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Your two-factor auth</h2>
    <div id="totp-panel" class="bg-stone-900 border border-green-900 px-4 py-4 text-sm"></div>
  </section>
</div>

<div id="toasts" aria-live="polite" class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end pointer-events-none"></div>`;

  const rows = app.querySelector<HTMLTableSectionElement>("#user-rows")!;
  const userCount = app.querySelector<HTMLSpanElement>("#user-count")!;
  const totpPanel = app.querySelector<HTMLDivElement>("#totp-panel")!;
  const toasts = app.querySelector<HTMLDivElement>("#toasts")!;

  // --- feedback ------------------------------------------------------------
  // Replaces `alert()`: a non-blocking, self-dismissing note in the corner, so
  // a failed save no longer interrupts whatever the admin was typing.
  const toast = (message: string, kind: "ok" | "error" = "ok") => {
    const el = document.createElement("div");
    el.className =
      `font-mono text-sm px-3 py-2 border bg-stone-950/95 shadow-lg transition-opacity duration-300 ` +
      (kind === "ok"
        ? "border-green-700 text-green-400"
        : "border-red-700 text-red-400");
    el.textContent = message;
    toasts.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }, kind === "ok" ? 2500 : 5000);
  };

  const spanRow = (html: string) =>
    `<tr><td colspan="6" class="py-3">${html}</td></tr>`;

  // --- user list -----------------------------------------------------------
  const pill = (text: string, tone: "on" | "off" | "admin" | "plain") => {
    const tones = {
      on: "border-green-700 text-green-400",
      off: "border-green-900 text-green-800",
      admin: "border-green-600 text-green-300",
      plain: "border-green-900 text-green-600",
    };
    return `<span class="border px-1.5 py-0.5 text-xs ${tones[tone]}">${esc(text)}</span>`;
  };

  const renderUsers = (users: AdminUser[]) => {
    rows.setAttribute("aria-busy", "false");
    userCount.textContent = users.length
      ? `${users.length} ${users.length === 1 ? "account" : "accounts"}`
      : "";
    if (!users.length) {
      rows.innerHTML = spanRow(`<span class="text-green-800">No users yet.</span>`);
      return;
    }
    rows.innerHTML = "";
    for (const user of users) {
      const tr = document.createElement("tr");
      tr.className = "border-b border-green-900/40 hover:bg-green-500/5 transition-colors";
      const isSelf = user.id === me.id;
      tr.innerHTML = `
        <td class="py-2 pr-4">${esc(user.name)}${isSelf ? " <span class='text-green-700'>(you)</span>" : ""}</td>
        <td class="py-2 pr-4">${pill(user.role, user.role === "admin" ? "admin" : "plain")}</td>
        <td class="py-2 pr-4">${user.totp_enabled ? pill("on", "on") : pill("off", "off")}</td>
        <td class="py-2 pr-4 text-green-700 whitespace-nowrap">${esc(fmtDateTime(user.created_at))}</td>
        <td class="py-2 pr-4 text-green-700 whitespace-nowrap">${esc(fmtDateTime(user.last_login))}</td>
        <td class="py-2 text-right whitespace-nowrap"></td>`;
      const actionCell = tr.querySelector("td:last-child")!;
      // Deleting an account is irreversible, so it takes two deliberate clicks
      // in place rather than a browser `confirm()` that can be muscle-memoried
      // away. The row shows what is about to be deleted the whole time.
      if (!isSelf) {
        const del = document.createElement("button");
        del.textContent = "delete";
        del.className = `text-red-500 hover:text-red-400 cursor-pointer ${RING} focus-visible:ring-red-500`;
        del.setAttribute("aria-label", `Delete ${user.name}`);
        del.onclick = () => {
          actionCell.innerHTML = "";
          const ask = document.createElement("span");
          ask.className = "text-red-400 mr-3";
          ask.textContent = "delete?";
          const yes = document.createElement("button");
          yes.textContent = "yes";
          yes.className = `text-red-500 hover:text-red-400 underline underline-offset-2 cursor-pointer mr-3 ${RING} focus-visible:ring-red-500`;
          yes.setAttribute("aria-label", `Confirm deleting ${user.name}`);
          const no = document.createElement("button");
          no.textContent = "cancel";
          no.className = BTN_QUIET + " underline underline-offset-2";
          no.onclick = () => {
            actionCell.innerHTML = "";
            actionCell.appendChild(del);
            del.focus();
          };
          yes.onclick = async () => {
            yes.disabled = no.disabled = true;
            ask.textContent = "deleting…";
            await deleteUser(user);
          };
          actionCell.append(ask, yes, no);
          no.focus();
        };
        actionCell.appendChild(del);
      }
      rows.appendChild(tr);
    }
  };

  const loadUsers = async () => {
    rows.setAttribute("aria-busy", "true");
    if (!rows.children.length) {
      rows.innerHTML = spanRow(`<span class="text-green-800">Loading users…</span>`);
    }
    try {
      const res = await api("/admin/users");
      if (!res.ok) {
        rows.innerHTML = spanRow(
          `<span class="text-red-400">${esc(await errorText(res))}</span>`,
        );
        rows.setAttribute("aria-busy", "false");
        userCount.textContent = "";
        return;
      }
      renderUsers(await res.json());
    } catch {
      rows.innerHTML = spanRow(
        `<span class="text-red-400">Network error — could not load users.</span>`,
      );
      rows.setAttribute("aria-busy", "false");
      userCount.textContent = "";
    }
  };

  const deleteUser = async (user: AdminUser) => {
    try {
      const res = await api(`/admin/users/${user.id}`, { method: "DELETE" });
      if (res.ok) {
        toast(`Deleted ${user.name}.`);
        await loadUsers();
      } else {
        toast(await errorText(res), "error");
        await loadUsers();
      }
    } catch {
      toast("Network error.", "error");
      await loadUsers();
    }
  };

  // --- create user ---------------------------------------------------------
  const createForm = app.querySelector<HTMLFormElement>("#create-form")!;
  const newName = app.querySelector<HTMLInputElement>("#new-name")!;
  const newPin = app.querySelector<HTMLInputElement>("#new-pin")!;
  const newRole = app.querySelector<HTMLSelectElement>("#new-role")!;
  const createSubmit = app.querySelector<HTMLButtonElement>("#create-submit")!;
  const createStatus = app.querySelector<HTMLParagraphElement>("#create-status")!;

  const setCreateStatus = (text: string, kind: "ok" | "error" | "none") => {
    createStatus.textContent = text;
    createStatus.className =
      "font-mono text-sm min-h-5 " +
      (kind === "error" ? "text-red-400" : kind === "ok" ? "text-green-500" : "text-green-800");
  };

  // Digits only, so a mistyped PIN fails here rather than at the server.
  newPin.addEventListener("input", () => {
    const digits = newPin.value.replace(/\D/g, "");
    if (digits !== newPin.value) newPin.value = digits;
  });

  createForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    // Without this, a fast double-click (or double Enter) fires two creates
    // before the first resolves, making two duplicate accounts.
    if (createSubmit.disabled) return;
    const name = newName.value.trim();
    const pin = newPin.value.trim();
    // Previously a blank field just did nothing, with no explanation.
    if (!name) {
      setCreateStatus("Enter a name.", "error");
      newName.focus();
      return;
    }
    if (!pin) {
      setCreateStatus("Enter a PIN.", "error");
      newPin.focus();
      return;
    }
    createSubmit.disabled = true;
    createSubmit.textContent = "Creating…";
    setCreateStatus("", "none");
    try {
      const res = await api(
        "/admin/users",
        jsonInit({ name, pin, role: newRole.value }),
      );
      if (res.ok) {
        newName.value = "";
        newPin.value = "";
        newRole.value = "standard";
        setCreateStatus(`Created ${name}.`, "ok");
        toast(`Created ${name}.`);
        newName.focus();
        await loadUsers();
      } else {
        setCreateStatus(await errorText(res), "error");
      }
    } catch {
      setCreateStatus("Network error.", "error");
    } finally {
      createSubmit.disabled = false;
      createSubmit.textContent = "Create";
    }
  });

  // --- 2FA panel -----------------------------------------------------------
  // Copies to the clipboard and reports back on the button itself, so there is
  // no doubt the secret/codes were actually captured.
  const copyOnClick = (btn: HTMLButtonElement, text: () => string) => {
    const label = btn.textContent;
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text());
        btn.textContent = "copied";
      } catch {
        btn.textContent = "copy failed";
      }
      setTimeout(() => (btn.textContent = label), 1500);
    };
  };

  const renderTotpPanel = () => {
    if (me.totp_enabled) {
      totpPanel.innerHTML = `
        <p class="text-green-400 mb-1">Two-factor authentication is <span class="text-green-300 font-bold">on</span>.</p>
        <p class="text-green-800 mb-3">Turning it off needs a current code from your authenticator, or one recovery code.</p>
        <div class="flex flex-col sm:flex-row gap-2">
          <label class="sr-only" for="disable-code">Current or recovery code</label>
          <input id="disable-code" type="text" placeholder="current or recovery code" autocomplete="off"
            class="${INPUT} flex-1" />
          <button id="disable-btn" class="${BTN_DANGER}">Disable</button>
        </div>
        <p id="totp-status" role="status" aria-live="polite" class="font-mono text-sm text-red-400 mt-2 min-h-5"></p>`;
      const btn = totpPanel.querySelector<HTMLButtonElement>("#disable-btn")!;
      const input = totpPanel.querySelector<HTMLInputElement>("#disable-code")!;
      btn.onclick = disableTotp;
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") disableTotp();
      });
    } else {
      totpPanel.innerHTML = `
        <p class="text-green-700 mb-1">Two-factor authentication is off.</p>
        <p class="text-green-800 mb-3">Add a code from an authenticator app on top of your PIN.</p>
        <button id="setup-btn" class="${BTN}">Enable 2FA</button>`;
      totpPanel.querySelector<HTMLButtonElement>("#setup-btn")!.onclick = startTotpSetup;
    }
  };

  const startTotpSetup = async () => {
    const btn = totpPanel.querySelector<HTMLButtonElement>("#setup-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Starting…";
    }
    try {
      const res = await api("/auth/totp/setup", { method: "POST" });
      if (!res.ok) {
        toast(await errorText(res), "error");
        renderTotpPanel();
        return;
      }
      const { secret_base32, otpauth_uri } = await res.json();
      totpPanel.innerHTML = `
        <ol class="text-green-400 mb-3 list-decimal list-inside space-y-1">
          <li>Add the secret below to your authenticator app.</li>
          <li>Enter the 6-digit code it shows to confirm.</li>
        </ol>
        <p class="mb-1 text-green-700 font-mono text-xs uppercase tracking-widest">Secret</p>
        <div class="flex items-center gap-3 mb-3">
          <code class="break-all text-green-300 bg-stone-950 border border-green-900 px-2 py-1 flex-1">${esc(secret_base32)}</code>
          <button id="copy-secret" class="${BTN_QUIET} underline underline-offset-2 shrink-0">copy</button>
        </div>
        <a href="${esc(otpauth_uri)}" class="text-green-600 hover:text-green-400 text-xs underline underline-offset-2 block mb-4">open in authenticator app</a>
        <div class="flex flex-col sm:flex-row gap-2">
          <label class="sr-only" for="enable-code">6-digit code</label>
          <input id="enable-code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code"
            class="${INPUT} flex-1" />
          <button id="enable-btn" class="${BTN}">Confirm</button>
          <button id="cancel-btn" class="${BTN_QUIET} px-2">cancel</button>
        </div>
        <p id="totp-status" role="status" aria-live="polite" class="font-mono text-sm text-red-400 mt-2 min-h-5"></p>`;
      const codeEl = totpPanel.querySelector<HTMLInputElement>("#enable-code")!;
      const submitCode = () => enableTotp(secret_base32, codeEl.value.trim());
      totpPanel.querySelector<HTMLButtonElement>("#enable-btn")!.onclick = submitCode;
      totpPanel.querySelector<HTMLButtonElement>("#cancel-btn")!.onclick = renderTotpPanel;
      codeEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") submitCode();
      });
      copyOnClick(
        totpPanel.querySelector<HTMLButtonElement>("#copy-secret")!,
        () => secret_base32,
      );
      codeEl.focus();
    } catch {
      toast("Network error.", "error");
      renderTotpPanel();
    }
  };

  const totpStatus = (text: string) => {
    const el = totpPanel.querySelector<HTMLParagraphElement>("#totp-status");
    if (el) el.textContent = text;
  };

  const enableTotp = async (secret: string, code: string) => {
    if (!code) return totpStatus("Enter the code from your authenticator app.");
    const btn = totpPanel.querySelector<HTMLButtonElement>("#enable-btn")!;
    btn.disabled = true;
    totpStatus("");
    try {
      const res = await api("/auth/totp/enable", jsonInit({ secret, code }));
      if (!res.ok) {
        totpStatus(await errorText(res));
        btn.disabled = false;
        return;
      }
      const { recovery_codes } = await res.json();
      me.totp_enabled = true;
      const codes = recovery_codes as string[];
      totpPanel.innerHTML = `
        <p class="text-green-400 mb-1 font-bold">2FA enabled.</p>
        <p class="text-red-400 mb-3">Save these recovery codes now — they won't be shown again.</p>
        <div class="grid grid-cols-2 gap-1 font-mono text-green-300 bg-stone-950 border border-green-900 p-3 mb-3">
          ${codes.map((c) => `<code>${esc(c)}</code>`).join("")}
        </div>
        <div class="flex items-center gap-4">
          <button id="copy-codes" class="${BTN_QUIET} underline underline-offset-2">copy all</button>
          <button id="totp-done" class="${BTN} ml-auto">Done</button>
        </div>`;
      copyOnClick(
        totpPanel.querySelector<HTMLButtonElement>("#copy-codes")!,
        () => codes.join("\n"),
      );
      totpPanel.querySelector<HTMLButtonElement>("#totp-done")!.onclick = () => {
        renderTotpPanel();
        toast("Two-factor auth is on.");
      };
    } catch {
      totpStatus("Network error.");
      btn.disabled = false;
    }
  };

  const disableTotp = async () => {
    const input = totpPanel.querySelector<HTMLInputElement>("#disable-code")!;
    const code = input.value.trim();
    if (!code) return totpStatus("Enter a current or recovery code.");
    const btn = totpPanel.querySelector<HTMLButtonElement>("#disable-btn")!;
    btn.disabled = true;
    totpStatus("");
    try {
      const res = await api("/auth/totp/disable", jsonInit({ code }));
      if (!res.ok) {
        totpStatus(await errorText(res));
        btn.disabled = false;
        return;
      }
      me.totp_enabled = false;
      renderTotpPanel();
      toast("Two-factor auth is off.");
    } catch {
      totpStatus("Network error.");
      btn.disabled = false;
    }
  };

  // --- log out -------------------------------------------------------------
  const logout = app.querySelector<HTMLButtonElement>("#logout")!;
  logout.onclick = async () => {
    logout.disabled = true;
    logout.textContent = "logging out…";
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
