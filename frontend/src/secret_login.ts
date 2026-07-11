// Login page. POSTs `{ name, pin, totp?, recovery? }` to `/api/auth/login?cookie=true`
// (nginx reroutes `/api` to the backend). `?cookie=true` makes the backend set an
// HttpOnly session cookie instead of us holding the token in JS, so every later
// `/api` call just needs `credentials: "include"`. When the account has 2FA on,
// the first attempt comes back `401 { totp_required: true }` and we reveal a code
// field (with a toggle to paste a recovery code instead).

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Sign in
    </h1>
  </a>

  <form id="login-form" class="w-full max-w-sm mt-8 flex flex-col gap-4">
    <input id="login-name" type="text" autocomplete="username" spellcheck="false"
      class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-3 text-green-300 placeholder-green-900 font-mono"
      placeholder="name" />
    <input id="login-pin" type="password" inputmode="numeric" autocomplete="current-password"
      class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-3 text-green-300 placeholder-green-900 font-mono"
      placeholder="pin" />

    <div id="login-2fa" class="hidden flex-col gap-2">
      <input id="login-code" type="text" inputmode="numeric" autocomplete="one-time-code" spellcheck="false"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-3 text-green-300 placeholder-green-900 font-mono"
        placeholder="6-digit code" />
      <label class="text-green-800 text-sm flex items-center gap-2 cursor-pointer select-none">
        <input id="login-recovery-toggle" type="checkbox" class="accent-green-700" />
        use a recovery code instead
      </label>
    </div>

    <button id="login-submit" type="submit"
      class="bg-green-700 hover:bg-green-600 active:bg-green-800 text-white font-bold px-6 py-3 rounded cursor-pointer transition-colors">
      Sign in
    </button>

    <div id="login-error" class="text-red-400 text-sm min-h-5 text-center"></div>
  </form>
</div>`;

  const form = app.querySelector<HTMLFormElement>("#login-form")!;
  const nameEl = app.querySelector<HTMLInputElement>("#login-name")!;
  const pinEl = app.querySelector<HTMLInputElement>("#login-pin")!;
  const twoFa = app.querySelector<HTMLDivElement>("#login-2fa")!;
  const codeEl = app.querySelector<HTMLInputElement>("#login-code")!;
  const recoveryToggle = app.querySelector<HTMLInputElement>("#login-recovery-toggle")!;
  const submit = app.querySelector<HTMLButtonElement>("#login-submit")!;
  const error = app.querySelector<HTMLDivElement>("#login-error")!;

  let totpRequired = false;

  recoveryToggle.addEventListener("change", () => {
    codeEl.placeholder = recoveryToggle.checked ? "recovery code" : "6-digit code";
    codeEl.inputMode = recoveryToggle.checked ? "text" : "numeric";
  });

  const submitLogin = async (ev: Event) => {
    ev.preventDefault();
    error.textContent = "";

    const name = nameEl.value.trim();
    const pin = pinEl.value;
    if (!name || !pin) {
      error.textContent = "Enter a name and pin.";
      return;
    }

    const payload: Record<string, string> = { name, pin };
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
    try {
      const res = await fetch("/api/auth/login?cookie=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        window.navigate("/secret/admin");
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
          (res.status === 401 ? "Wrong name or pin." : `Error ${res.status}`);
      }
    } catch {
      error.textContent = "Network error — is the API up?";
    } finally {
      submit.disabled = false;
    }
  };

  form.addEventListener("submit", submitLogin);
  nameEl.focus();
};
