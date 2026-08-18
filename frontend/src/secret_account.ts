// Account page — open to any signed-in user (the router gates it and hands the
// resolved user in as `me`). Its one job is changing your own PIN via
// `POST /api/auth/pin`, which re-checks the current PIN (and the 2FA code, when
// enrolled) server-side. There is no user id in the request: the backend takes
// the account from the session cookie, so this page can only ever change your
// own PIN. A success signs every other session out, so we say so.

import { PAGE_CLASS } from "./helpers";
import type { Me } from "./session.ts";

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
  if (res.status === 401) return "That pin (or code) isn't right.";
  if (res.status === 429) return "Too many failed attempts. Try again later.";
  return `Error ${res.status}`;
};

// Escapes text for safe interpolation into innerHTML — user names are set
// freely by an admin and must never reach innerHTML raw.
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

const inputClass =
  "w-full bg-stone-950 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono";

export default async (app: HTMLElement, me: Me) => {
  app.innerHTML = `
<div class="${PAGE_CLASS}">
  <div class="w-full max-w-xl flex items-center justify-between">
    <a href="/secret" title="Back to the secret menu">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Account
      </h1>
    </a>
    <div class="flex items-center gap-4 text-sm text-green-700">
      ${me.role === "admin" ? `<a href="/secret/admin" class="hover:text-green-400">admin</a>` : ""}
      <span>signed in as <span class="text-green-400">${esc(me.name)}</span></span>
    </div>
  </div>

  <div class="w-full max-w-xl mt-8 flex flex-col gap-3">
    <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Change your pin</h2>
    <form id="pin-form" class="bg-stone-900 border border-green-900 px-4 py-4 flex flex-col gap-3 text-sm">
      <label class="flex flex-col gap-1">
        <span class="text-green-700">Current pin</span>
        <input id="current-pin" type="password" inputmode="numeric" autocomplete="current-password"
          class="${inputClass}" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-green-700">New pin</span>
        <input id="new-pin" type="password" inputmode="numeric" autocomplete="new-password"
          class="${inputClass}" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-green-700">Confirm new pin</span>
        <input id="confirm-pin" type="password" inputmode="numeric" autocomplete="new-password"
          class="${inputClass}" />
      </label>
      ${
        me.totp_enabled
          ? `<label class="flex flex-col gap-1">
        <span class="text-green-700">2FA code</span>
        <input id="totp-code" type="text" inputmode="numeric" autocomplete="one-time-code"
          placeholder="current or recovery code" class="${inputClass}" />
      </label>`
          : ""
      }
      <p id="pin-status" class="min-h-5 text-green-700"></p>
      <button id="pin-submit" type="submit"
        class="self-start bg-transparent border border-green-500 hover:bg-green-500/10 active:bg-green-500/20 disabled:opacity-60 disabled:cursor-not-allowed text-green-400 font-bold px-5 py-2 cursor-pointer transition-colors">
        Update pin
      </button>
      <p class="text-green-800 text-xs">
        Your pin is your whole sign-in, so changing it signs out every other device.
      </p>
    </form>
  </div>
</div>`;

  const form = app.querySelector<HTMLFormElement>("#pin-form")!;
  const currentPin = app.querySelector<HTMLInputElement>("#current-pin")!;
  const newPin = app.querySelector<HTMLInputElement>("#new-pin")!;
  const confirmPin = app.querySelector<HTMLInputElement>("#confirm-pin")!;
  const totpCode = app.querySelector<HTMLInputElement>("#totp-code");
  const submit = app.querySelector<HTMLButtonElement>("#pin-submit")!;
  const status = app.querySelector<HTMLParagraphElement>("#pin-status")!;

  const setStatus = (text: string, ok: boolean) => {
    status.textContent = text;
    status.className = `min-h-5 ${ok ? "text-green-400" : "text-red-400"}`;
  };

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    // A double submit would send the (now stale) current pin twice, burning an
    // attempt against the per-IP ban for nothing.
    if (submit.disabled) return;

    const current = currentPin.value;
    const next = newPin.value;
    if (!current || !next) return setStatus("Fill in both pins.", false);
    if (next !== confirmPin.value)
      return setStatus("The new pins don't match.", false);
    if (next === current)
      return setStatus("The new pin must differ from the current one.", false);
    if (next.trim().length < 4)
      return setStatus("The new pin must be at least 4 characters.", false);

    submit.disabled = true;
    setStatus("Updating…", true);
    try {
      const res = await api(
        "/auth/pin",
        jsonInit({
          current_pin: current,
          new_pin: next,
          code: totpCode?.value.trim() || undefined,
        }),
      );
      if (!res.ok) {
        setStatus(await errorText(res), false);
        return;
      }
      form.reset();
      setStatus("Pin updated. Other devices have been signed out.", true);
    } catch {
      setStatus("Network error.", false);
    } finally {
      submit.disabled = false;
    }
  });
};
