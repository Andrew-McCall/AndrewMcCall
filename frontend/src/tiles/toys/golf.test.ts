import { describe, expect, it } from "vitest";
import { COST, chaos, design, drainPath } from "./golf";
import { rng } from "../toy";

type Point = [number, number];

const strip = (length: number): Point[] =>
  Array.from({ length }, (_, x) => [x, 0]);

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
    const portals: Point[] = [
      [0, 0],
      [3, 0],
    ];
    expect(drainPath(strip(5), water, [0, 0], [4, 0], portals)).toEqual([]);
  });

  it("drains the fewest ponds across a wide lake", () => {
    const cells: Point[] = [];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 3; y++) cells.push([x, y]);
    const water = new Set(["1,0", "1,1", "1,2", "2,0", "2,2"]);
    expect(drainPath(cells, water, [0, 1], [3, 1])).toEqual(["1,1"]);
  });
});

describe("chaos", () => {
  it("starts flat and grows 14% a level", () => {
    expect(chaos(0)).toBe(0);
    expect(chaos(1)).toBe(8);
    for (let n = 1; n < 30; n++)
      expect(chaos(n + 1)).toBeCloseTo(chaos(n) * 1.14);
  });
});

describe("design", () => {
  const path: Point[] = Array.from({ length: 8 }, (_, x) => [x, 2]);
  const ends = ["0,2", "7,2"];

  it("keeps the first hole flat", () => {
    const { fairway, placed } = design(path, chaos(0), rng(1));
    expect(fairway.size).toBe(path.length);
    expect(placed).toEqual([]);
  });

  it("spends the budget on grass and obstacles without going over", () => {
    for (let seed = 1; seed < 300; seed++) {
      const budget = chaos(1 + (seed % 12));
      const { fairway, placed } = design(path, budget, rng(seed));
      const portals = placed.filter((p) => p.kind === "portal").length;
      const things =
        placed.reduce((sum, p) => sum + COST[p.kind], 0) -
        (portals / 2) * COST.portal;
      const grass = fairway.size - path.length;
      expect(things + grass).toBeLessThanOrEqual(budget);
      const cells = placed.map((p) => p.at.join());
      expect(new Set(cells).size).toBe(cells.length);
      expect(cells.some((c) => ends.includes(c))).toBe(false);
      expect([0, 2]).toContain(portals);
    }
  });

  it("builds patterns such as a belt into water", () => {
    let seen = 0;
    for (let seed = 1; seed < 300; seed++) {
      const { placed } = design(path, chaos(12), rng(seed));
      const at = new Map(placed.map((p) => [p.at.join(), p]));
      for (const p of placed) {
        if (p.kind !== "belt") continue;
        const next = at.get([p.at[0] + p.dir[0], p.at[1] + p.dir[1]].join());
        if (next?.dir === p.dir && next.kind === "water") seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("makes portals rare", () => {
    let holes = 0;
    for (let seed = 1; seed < 500; seed++) {
      const { placed } = design(path, chaos(6), rng(seed));
      if (placed.some((p) => p.kind === "portal")) holes++;
    }
    expect(holes).toBeLessThan(50);
  });
});
