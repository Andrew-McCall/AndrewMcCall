// Shared session helper. The HttpOnly cookie set at login rides along on every
// `credentials: "include"` request; `/api/auth/me` resolves it to the current
// user (or a 401 when signed out). The router (`main.ts`) calls `getMe` once per
// navigation to gate protected pages and hands the result to the page, so no
// page has to re-implement the "am I signed in?" bounce.

export type Me = {
  id: string;
  name: string;
  role: string;
  totp_enabled: boolean;
};

// Resolves the current session, or `null` when signed out or the API is down.
export async function getMe(): Promise<Me | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
}
