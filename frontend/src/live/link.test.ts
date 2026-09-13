import { describe, expect, it } from "vitest";
import { roomPath, titleFrom } from "./link";

describe("a room's link", () => {
  it("carries the title the room was started with", () => {
    expect(roomPath("blue-otter-lamp", "Friday music")).toBe(
      "/secret/live/blue-otter-lamp?title=Friday%20music",
    );
  });

  it("writes spaces as %20, since the backend reads a + literally", () => {
    expect(roomPath("x", "Friday music")).not.toContain("+");
  });

  it("is just the room when there is no title to carry", () => {
    expect(roomPath("blue-otter-lamp")).toBe("/secret/live/blue-otter-lamp");
  });

  it("reads the title back out", () => {
    expect(titleFrom("?title=Friday%20music")).toBe("Friday music");
  });

  it("survives a title with a plus in it", () => {
    expect(titleFrom(roomPath("x", "C++ talk").slice("/secret/live/x".length))).toBe(
      "C++ talk",
    );
  });

  it("reads nothing from a shared link", () => {
    expect(titleFrom("")).toBe("");
  });
});
