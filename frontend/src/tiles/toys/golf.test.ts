import { describe, expect, it } from "vitest";
import { drainPath } from "./golf";

type Point = [number, number];

const strip = (length: number): Point[] => Array.from({ length }, (_, x) => [x, 0]);

describe("drainPath", () => {
  it("drains nothing when the way is dry", () => {
    expect(drainPath(strip(4), new Set(), [0, 0], [3, 0])).toEqual([]);
  });

  it("drains only the pond that blocks the only way", () => {
    const water = new Set(["1,0", "2,1"]);
    const cells: Point[] = [...strip(4), [2, 1]];
    expect(drainPath(cells, water, [0, 0], [3, 0])).toEqual(["1,0"]);
  });

  it("keeps water when a dry detour exists", () => {
    const cells: Point[] = [...strip(3), [0, 1], [1, 1], [2, 1]];
    expect(drainPath(cells, new Set(["1,0"]), [0, 0], [2, 0])).toEqual([]);
  });

  it("counts a portal as a way past the water", () => {
    const water = new Set(["1,0", "2,0"]);
    const portals: Point[] = [[0, 0], [3, 0]];
    expect(drainPath(strip(5), water, [0, 0], [4, 0], portals)).toEqual([]);
  });

  it("drains the fewest ponds across a wide lake", () => {
    const cells: Point[] = [];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 3; y++) cells.push([x, y]);
    const water = new Set(["1,0", "1,1", "1,2", "2,0", "2,2"]);
    expect(drainPath(cells, water, [0, 1], [3, 1])).toEqual(["1,1"]);
  });
});
