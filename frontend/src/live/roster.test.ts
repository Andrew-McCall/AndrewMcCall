import { describe, expect, it } from "vitest";
import { apply, labels, type Room } from "./roster";

const silent = { mic: false, app: false, camera: false, screen: false };

const peer = (id: string, name: string, seq: number) => ({
  peer_id: id,
  name,
  seq,
  sources: silent,
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

  it("records what a peer is publishing", () => {
    const room: Room = {
      self: "me",
      seq: 0,
      title: "Friday music",
      peers: [peer("a", "Alice", 1)],
    };

    const next = apply(room, {
      kind: "sources",
      from: "a",
      sources: { mic: true, app: true, camera: false, screen: false },
    });

    expect(next!.peers[0]!.sources).toEqual({
      mic: true,
      app: true,
      camera: false,
      screen: false,
    });
  });

  it("ignores what someone who is not here is publishing", () => {
    const room: Room = {
      self: "me",
      seq: 0,
      title: "Friday music",
      peers: [peer("a", "Alice", 1)],
    };

    const next = apply(room, {
      kind: "sources",
      from: "ghost",
      sources: { mic: true, app: false, camera: false, screen: false },
    });

    expect(next!.peers).toHaveLength(1);
    expect(next!.peers[0]!.sources).toEqual(silent);
  });
});

describe("tile labels", () => {
  it("leaves distinct names alone", () => {
    const out = labels([peer("a", "Alice", 0), peer("b", "Bob", 1)]);

    expect(out.get("a")).toBe("Alice");
    expect(out.get("b")).toBe("Bob");
  });

  it("numbers one account signed in twice, in join order", () => {
    const out = labels([
      peer("phone", "Andrew", 3),
      peer("laptop", "Andrew", 1),
      peer("b", "Bob", 2),
    ]);

    expect(out.get("laptop")).toBe("Andrew (1)");
    expect(out.get("phone")).toBe("Andrew (2)");
    expect(out.get("b")).toBe("Bob");
  });
});
