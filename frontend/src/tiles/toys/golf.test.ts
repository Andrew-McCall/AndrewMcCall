import { describe, expect, it } from "vitest";
import { COST, chaos, drainPath, scatter, widen } from "./golf";
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
  it("starts flat and grows 20% a level", () => {
    expect(chaos(0)).toBe(0);
    for (let n = 1; n < 10; n++)
      expect(chaos(n + 1)).toBeCloseTo(chaos(n) * 1.2);
  });
});

describe("scatter", () => {
  const grid: Point[] = [];
  for (let x = 0; x < 8; x++) for (let y = 0; y < 5; y++) grid.push([x, y]);

  it("places nothing on a flat hole", () => {
    expect(scatter(0, grid, rng(1))).toEqual([]);
  });

  it("spends the budget without going over and uses each spot once", () => {
    for (let seed = 1; seed < 300; seed++) {
      const budget = chaos(1 + (seed % 12));
      const placed = scatter(budget, grid, rng(seed));
      const portals = placed.filter((p) => p.kind === "portal").length;
      const spent =
        placed.reduce((sum, p) => sum + COST[p.kind], 0) -
        (portals / 2) * COST.portal;
      expect(spent).toBeLessThanOrEqual(budget);
      expect(new Set(placed.map((p) => p.at.join())).size).toBe(placed.length);
      expect([0, 2]).toContain(portals);
    }
  });

  it("points a belt into the next part of its pattern", () => {
    let seen = 0;
    for (let seed = 1; seed < 300; seed++) {
      const placed = scatter(chaos(12), grid, rng(seed));
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
      if (scatter(chaos(6), grid, rng(seed)).some((p) => p.kind === "portal"))
        holes++;
    }
    expect(holes).toBeLessThan(50);
  });
});

describe("widen", () => {
  const path: Point[] = strip(8);

  it("adds no grass without chaos", () => {
    expect(widen(path, rng(1), 0)).toEqual({
      fairway: new Set(path.map(([x]) => x)),
      left: 0,
    });
  });

  it("pays for each grass cell", () => {
    const { fairway, left } = widen(path, rng(7), 3.2);
    expect(fairway.size).toBe(path.length + 3);
    expect(left).toBeCloseTo(0.2);
  });
});
