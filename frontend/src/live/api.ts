// The wire: one POST per message going up, one event stream coming down.
//
// The stream is the membership. Opening `/live/rooms/{id}/events` joins the
// room and closing it leaves, so nothing here has a "leave" call — dropping the
// EventSource is the goodbye, which also covers the tab being closed.

import type { CreatedRoom, PeerSummary, RoomSummary } from "@andrewmccall/api-types";
import { api, errorText, jsonInit } from "../helpers";

// The payload of a relayed signalling message. `payload` is an SDP or an ICE
// candidate — the server passes it through untouched and neither end needs a
// type for it here.
export interface Signal {
  from: string;
  kind: "offer" | "answer" | "ice";
  payload: unknown;
}

export interface RoomHandlers {
  hello: (data: {
    peer_id: string;
    seq: number;
    title: string;
    roster: PeerSummary[];
  }) => void;
  joined: (peer: PeerSummary) => void;
  left: (peer_id: string) => void;
  signal: (signal: Signal) => void;
  // Called when the stream drops. EventSource reconnects by itself, and a
  // reconnect re-joins with a fresh peer id and a fresh hello.
  dropped: () => void;
}

// Picks an id to open a room on. No room exists until someone's stream joins it.
export async function createRoom(title: string): Promise<CreatedRoom> {
  const res = await api("/live/rooms", jsonInit({ title }));
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

// Watches the lobby. Returns the function that stops watching.
export function watchLobby(onRooms: (rooms: RoomSummary[]) => void): () => void {
  const stream = new EventSource("/api/live/events");
  stream.addEventListener("rooms", (event) => {
    onRooms(JSON.parse((event as MessageEvent).data));
  });
  return () => stream.close();
}

// Joins a room. Returns the function that leaves it.
//
// The title is only used if this is the join that opens the room; spaces are
// encoded as %20 rather than `+`, which the server would take literally.
export function joinRoom(
  id: string,
  title: string,
  handlers: RoomHandlers,
): () => void {
  const stream = new EventSource(
    `/api/live/rooms/${encodeURIComponent(id)}/events?title=${encodeURIComponent(title)}`,
  );

  const on = (name: string, handle: (data: any) => void) =>
    stream.addEventListener(name, (event) =>
      handle(JSON.parse((event as MessageEvent).data)),
    );

  on("hello", handlers.hello);
  on("peer-joined", handlers.joined);
  on("peer-left", (data) => handlers.left(data.peer_id));
  on("signal", handlers.signal);
  stream.addEventListener("error", () => handlers.dropped());

  return () => stream.close();
}

// Hands one offer, answer or candidate to one other peer.
export async function sendSignal(
  roomId: string,
  message: { from: string; to: string; kind: Signal["kind"]; payload: unknown },
): Promise<void> {
  const res = await api(
    `/live/rooms/${encodeURIComponent(roomId)}/signal`,
    jsonInit(message),
  );
  if (!res.ok) throw new Error(await errorText(res));
}
