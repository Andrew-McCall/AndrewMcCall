// Inline PIN-only sign-in, mounted straight into the secret menu (no separate
// page). POSTs `{ pin, totp?, recovery? }` to `/api/auth/login?cookie=true`
// (nginx reroutes `/api` to the backend). `?cookie=true` makes the backend set
// an HttpOnly session cookie instead of us holding the token in JS, so every
// later `/api` call just needs `credentials: "include"`. When the account has
// 2FA on, the first attempt comes back `401 { totp_required: true }` and we
// reveal a code field (with a toggle to paste a recovery code instead).
//
// On load it asks `/api/auth/me`: already-signed-in users get a compact "signed
// in" panel (with an Admin link for admins); everyone else gets the PIN box.

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

// Compact panel shown when a session already exists.
function renderSignedIn(
  container: HTMLElement,
  me: Me,
  onChange?: () => void,
): void {
  const adminLink =
    me.role === "admin"
      ? `<a href="/secret/admin" class="text-lime-400 hover:underline hover:text-lime-700">Admin</a>`
      : "";
  container.innerHTML = `
<div class="flex flex-col items-center gap-2 text-sm">
  <p class="text-green-700">signed in as <span class="text-green-400 font-mono">${me.name}</span></p>
  <div class="flex items-center gap-4">
    ${adminLink}
    <button id="secret-logout" class="text-green-700 hover:text-green-400 cursor-pointer">log out</button>
  </div>
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

// The PIN entry form (with the lazily-revealed 2FA field).
function renderForm(container: HTMLElement, onChange?: () => void): void {
  container.innerHTML = `
<form id="login-form" class="w-full max-w-xs mx-auto flex flex-col gap-3">
  <input id="login-pin" type="password" inputmode="numeric" autocomplete="current-password" aria-label="PIN"
    class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-3 text-center tracking-[0.5em] text-green-300 placeholder-green-900 font-mono"
    placeholder="pin" />

  <div id="login-2fa" class="hidden flex-col gap-2">
    <input id="login-code" type="text" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" aria-label="Authentication code"
      class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-3 text-green-300 placeholder-green-900 font-mono"
      placeholder="6-digit code" />
    <label class="text-green-800 text-sm flex items-center gap-2 cursor-pointer select-none">
      <input id="login-recovery-toggle" type="checkbox" class="accent-green-700" />
      use a recovery code instead
    </label>
  </div>

  <button id="login-submit" type="submit"
    class="bg-green-700 hover:bg-green-600 active:bg-green-800 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold px-6 py-2 rounded cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">
    Sign in
  </button>

  <div id="login-error" class="text-red-400 text-sm min-h-5 text-center"></div>
</form>`;

  const form = container.querySelector<HTMLFormElement>("#login-form")!;
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

  pinEl.focus();
}
