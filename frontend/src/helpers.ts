// Shared page helpers (previously duplicated across the secret_* pages).

export const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

export const jsonInit = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Reads `{ error }` from a non-2xx JSON body, falling back to the status.
export const errorText = async (res: Response): Promise<string> => {
  const body = await res.json().catch(() => null);
  if (body && typeof body.error === "string") return body.error;
  return `Error ${res.status}`;
};

export const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString() : "—";

// Escapes text for safe interpolation into innerHTML.
export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
