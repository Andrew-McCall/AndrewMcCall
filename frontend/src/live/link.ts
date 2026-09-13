// The shape of a room's URL, in one place because both ends of it matter: the
// lobby writes the link and the room page reads it back.
//
// A title rides along as a query parameter because a room is created by the
// first stream that joins it — the server has nowhere to keep the title
// between "pick me an id" and "someone arrived". A shared link carries no
// title, which is correct: that room already exists and already has one.

export function roomPath(id: string, title?: string): string {
  const path = `/secret/live/${encodeURIComponent(id)}`;
  // encodeURIComponent, not URLSearchParams: the latter writes a space as `+`,
  // which the backend takes literally and shows as "Friday+music".
  return title ? `${path}?title=${encodeURIComponent(title)}` : path;
}

export function titleFrom(search: string): string {
  return new URLSearchParams(search).get("title") ?? "";
}
