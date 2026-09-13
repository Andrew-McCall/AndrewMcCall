// Who is in the room, kept as plain data so it can be reasoned about without a
// browser. The page renders whatever this returns; nothing here touches the DOM
// or a peer connection.

import type { PeerSummary, Sources } from "@andrewmccall/api-types";

export interface Room {
  // This tab's own peer id, as minted by the server.
  self: string;
  // Join order. The lower sequence offers to the higher, which is how two
  // browsers agree who starts a connection without asking the server.
  seq: number;
  title: string;
  // Everyone else, in join order.
  peers: PeerSummary[];
}

export type LiveEvent =
  | { kind: "hello"; peer_id: string; seq: number; title: string; roster: PeerSummary[] }
  | { kind: "peer-joined"; peer: PeerSummary }
  | { kind: "peer-left"; peer_id: string }
  | { kind: "sources"; from: string; sources: Sources };

const byJoinOrder = (a: PeerSummary, b: PeerSummary) => a.seq - b.seq;

export function apply(room: Room | null, event: LiveEvent): Room | null {
  if (event.kind === "hello") {
    return {
      self: event.peer_id,
      seq: event.seq,
      title: event.title,
      peers: [...event.roster].sort(byJoinOrder),
    };
  }

  // Anything arriving before hello has nothing to apply to. The server sends
  // hello first, so this only happens on a stream that is already broken.
  if (!room) return room;

  if (event.kind === "peer-joined") {
    // A repeated arrival is a reconnect, not a second person.
    if (room.peers.some((peer) => peer.peer_id === event.peer.peer_id)) {
      return room;
    }
    return { ...room, peers: [...room.peers, event.peer].sort(byJoinOrder) };
  }

  if (event.kind === "sources") {
    return {
      ...room,
      peers: room.peers.map((peer) =>
        peer.peer_id === event.from ? { ...peer, sources: event.sources } : peer,
      ),
    };
  }

  return {
    ...room,
    peers: room.peers.filter((peer) => peer.peer_id !== event.peer_id),
  };
}
