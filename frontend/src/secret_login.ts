// Inline PIN-only sign-in, mounted straight into the secret menu (no separate
// page). POSTs `{ pin, totp?, recovery? }` to `/api/auth/login?cookie=true`
// (nginx reroutes `/api` to the backend). `?cookie=true` makes the backend set
// an HttpOnly session cookie instead of us holding the token in JS, so every
// later `/api` call just needs `credentials: "include"`. When the account has
// 2FA on, the first attempt comes back `401 { totp_required: true }` and we
// reveal a code field (with a toggle to paste a recovery code instead).
//
// Rendered into the secret-menu header slot. Signed-in users get a compact
// identity chip (name · admin · log out); everyone else gets a "sign in" button
// that toggles a dropdown holding the PIN box. Pass `me` (or null) to skip the
// `/auth/me` fetch.

type Me = { name: string; role: string };

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

// Renders the sign-in area into `container`, choosing the signed-in panel or the
// PIN form based on the current session. Pass `me` (or null) to skip the
// `/auth/me` fetch; `onChange` fires after a sign-in or sign-out instead of the
// default in-place re-render.
export async function mountLogin(
  container: HTMLElement,
  me?: Me | null,
  onChange?: () => void,
): Promise<void> {
  if (me === undefined) {
    try {
      const res = await api("/auth/me");
      me = res.ok ? await res.json() : null;
    } catch {
      me = null; // offline / API down — fall through to the PIN form
    }
  }
  if (me) renderSignedIn(container, me, onChange);
  else renderForm(container, onChange);
}

// Compact identity chip shown when a session already exists, pinned in the
// secret-menu header.
function renderSignedIn(
  container: HTMLElement,
  me: Me,
  onChange?: () => void,
): void {
  const adminLink =
    me.role === "admin"
      ? `<a href="/secret/admin" class="text-lime-400 hover:underline hover:text-lime-200">admin</a>
    <span class="text-green-900">·</span>`
      : "";
  container.innerHTML = `
<div class="inline-flex items-center gap-2 text-xs font-mono bg-stone-900 border border-green-900 px-3 py-1.5">
  <span class="text-green-600">&#9656;</span>
  <span class="text-green-400">${me.name}</span>
  <span class="text-green-900">·</span>
  ${adminLink}
  <button id="secret-logout" class="text-green-700 hover:text-green-400 cursor-pointer">log out</button>
</div>`;

  container.querySelector<HTMLButtonElement>("#secret-logout")!.onclick =
    async () => {
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
        /* clearing the cookie server-side is best-effort */
      }
      if (onChange) onChange();
      else renderForm(container);
    };
}

// Signed-out state: a compact "sign in" button that toggles a dropdown panel
// holding the PIN form (with the lazily-revealed 2FA field). Anchored to the
// `relative` header slot.
function renderForm(container: HTMLElement, onChange?: () => void): void {
  container.innerHTML = `
<button id="signin-toggle" type="button" aria-expanded="false"
  class="text-xs font-mono bg-stone-900 border border-green-900 hover:border-green-600 text-green-400 hover:text-lime-300 px-3 py-1.5 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">
  sign in
</button>
<div id="signin-panel" class="hidden absolute right-0 top-full mt-2 z-20 w-64 bg-stone-950 border border-green-900 p-4 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.6)]">
  <form id="login-form" class="w-full flex flex-col gap-3">
    <input id="login-pin" type="password" inputmode="numeric" autocomplete="current-password" aria-label="PIN"
      class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-3 text-center tracking-[0.5em] text-green-300 placeholder-green-900 font-mono"
      placeholder="pin" />

    <div id="login-2fa" class="hidden flex-col gap-2">
      <input id="login-code" type="text" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" aria-label="Authentication code"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-3 text-green-300 placeholder-green-900 font-mono"
        placeholder="6-digit code" />
      <label class="text-green-800 text-sm flex items-center gap-2 cursor-pointer select-none">
        <input id="login-recovery-toggle" type="checkbox" class="accent-green-700" />
        use a recovery code instead
      </label>
    </div>

    <button id="login-submit" type="submit"
      class="bg-transparent border border-green-500 hover:bg-green-500/10 active:bg-green-500/20 disabled:opacity-60 disabled:cursor-not-allowed text-green-400 font-bold px-6 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">
      Sign in
    </button>

    <div id="login-error" class="text-red-400 text-sm min-h-5 text-center"></div>
  </form>
</div>`;

  const toggle = container.querySelector<HTMLButtonElement>("#signin-toggle")!;
  const panel = container.querySelector<HTMLDivElement>("#signin-panel")!;
  const form = container.querySelector<HTMLFormElement>("#login-form")!;

  // Close the dropdown on an outside click or Escape; the listeners live only
  // while the panel is open so nothing leaks after sign-in re-renders the slot.
  const onOutside = (ev: MouseEvent) => {
    if (!container.contains(ev.target as Node)) closePanel();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") closePanel();
  };
  function openPanel(): void {
    panel.classList.remove("hidden");
    toggle.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    pinEl.focus();
  }
  function closePanel(): void {
    panel.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onKey);
  }
  toggle.addEventListener("click", () =>
    panel.classList.contains("hidden") ? openPanel() : closePanel(),
  );

  const pinEl = container.querySelector<HTMLInputElement>("#login-pin")!;
  const twoFa = container.querySelector<HTMLDivElement>("#login-2fa")!;
  const codeEl = container.querySelector<HTMLInputElement>("#login-code")!;
  const recoveryToggle = container.querySelector<HTMLInputElement>(
    "#login-recovery-toggle",
  )!;
  const submit = container.querySelector<HTMLButtonElement>("#login-submit")!;
  const error = container.querySelector<HTMLDivElement>("#login-error")!;

  let totpRequired = false;

  recoveryToggle.addEventListener("change", () => {
    codeEl.placeholder = recoveryToggle.checked ? "recovery code" : "6-digit code";
    codeEl.inputMode = recoveryToggle.checked ? "text" : "numeric";
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    error.textContent = "";

    const pin = pinEl.value;
    if (!pin) {
      error.textContent = "Enter your pin.";
      return;
    }

    const payload: Record<string, string> = { pin };
    if (totpRequired) {
      const code = codeEl.value.trim();
      if (!code) {
        error.textContent = "Enter your authentication code.";
        return;
      }
      if (recoveryToggle.checked) payload.recovery = code;
      else payload.totp = code;
    }

    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      const res = await fetch("/api/auth/login?cookie=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        // Swap this panel to the signed-in view in place — most accounts
        // aren't admins, so navigating to /secret/admin here would just get
        // them bounced straight back by the router's auth gate.
        closePanel(); // detach the outside-click/Escape listeners before re-render
        if (onChange) onChange();
        else await mountLogin(container);
        return;
      }

      const body = await res.json().catch(() => null);
      if (res.status === 401 && body?.totp_required) {
        totpRequired = true;
        twoFa.classList.remove("hidden");
        twoFa.classList.add("flex");
        codeEl.focus();
        error.textContent = "Enter the code from your authenticator.";
      } else {
        error.textContent =
          (body && typeof body.error === "string" && body.error) ||
          (res.status === 401 ? "Wrong pin." : `Error ${res.status}`);
      }
    } catch {
      error.textContent = "Network error — is the API up?";
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });
}
