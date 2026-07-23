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

// Rough read time in whole minutes (>=1) from a word count at 200 wpm.
export const readingTime = (text: string): number => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
};

// Updates the document title and description/Open-Graph tags for the current
// page, creating the meta elements on first use. Full-reload navigation resets
// the head from index.html, so pages only ever need to set, never restore.
export const setMeta = (title: string, description: string): void => {
  document.title = title;
  const tag = (selector: string, attr: string, val: string) => {
    let el = document.head.querySelector<HTMLMetaElement>(selector);
    if (!el) {
      el = document.createElement("meta");
      const [name, value] = attr.split("=");
      el.setAttribute(name, value);
      document.head.appendChild(el);
    }
    el.setAttribute("content", val);
  };
  tag('meta[name="description"]', "name=description", description);
  tag('meta[property="og:title"]', "property=og:title", title);
  tag('meta[property="og:description"]', "property=og:description", description);
};

// Escapes text for safe interpolation into innerHTML.
export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
