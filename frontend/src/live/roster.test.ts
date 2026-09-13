import { describe, expect, it } from "vitest";
import { apply, type Room } from "./roster";

const peer = (id: string, name: string, seq: number) => ({
  peer_id: id,
  name,
  seq,
});

describe("the room roster", () => {
  it("starts from the hello the server opens with", () => {
    const room = apply(null, {
      kind: "hello",
      peer_id: "me",
      seq: 2,
      title: "Friday music",
      roster: [peer("a", "Alice", 0), peer("b", "Bob", 1)],
    });

    expect(room).toEqual({
      self: "me",
      seq: 2,
      title: "Friday music",
      peers: [peer("a", "Alice", 0), peer("b", "Bob", 1)],
    });
  });

  it("keeps arrivals in join order", () => {
    const room: Room = {
      self: "me",
      seq: 0,
      title: "Friday music",
      peers: [peer("c", "Carol", 2)],
    };

    const next = apply(room, { kind: "peer-joined", peer: peer("b", "Bob", 1) });

    expect(next!.peers.map((p) => p.name)).toEqual(["Bob", "Carol"]);
  });

  it("drops whoever left", () => {
    const room: Room = {
      self: "me",
      seq: 0,
      title: "Friday music",
      peers: [peer("a", "Alice", 1), peer("b", "Bob", 2)],
    };

    const next = apply(room, { kind: "peer-left", peer_id: "a" });

    expect(next!.peers.map((p) => p.name)).toEqual(["Bob"]);
  });

  it("does not list the same peer twice when an arrival repeats", () => {
    const room: Room = {
      self: "me",
      seq: 0,
      title: "Friday music",
      peers: [peer("a", "Alice", 1)],
    };

    const next = apply(room, { kind: "peer-joined", peer: peer("a", "Alice", 1) });

    expect(next!.peers).toHaveLength(1);
  });
});
