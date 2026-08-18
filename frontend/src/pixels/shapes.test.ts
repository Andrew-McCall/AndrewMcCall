import { describe, expect, test } from "vitest";
import {
  SHAPES,
  defaultsFor,
  generate,
  maxThicknessFor,
  shapeById,
  visibleInputs,
  type Values,
} from "./shapes";
import { components, filledCount, toRows } from "./test-helpers";

const options = (over: Partial<Parameters<typeof generate>[2]> = {}) => ({
  mode: "outline" as const,
  thickness: 1,
  bias: -0.5,
  ...over,
});

describe("the shape table", () => {
  test("gives every input a default inside its own range", () => {
    for (const shape of SHAPES) {
      for (const input of shape.inputs) {
        if (input.type !== "int" && input.type !== "ratio") continue;
        expect(input.default, `${shape.id}.${input.key}`).toBeGreaterThanOrEqual(
          input.min!,
        );
        expect(input.default, `${shape.id}.${input.key}`).toBeLessThanOrEqual(
          input.max!,
        );
      }
    }
  });

  test("gives every choice input a default it actually offers", () => {
    for (const shape of SHAPES) {
      for (const input of shape.inputs) {
        if (input.type !== "choice") continue;
        expect(input.options, `${shape.id}.${input.key}`).toContain(
          input.default,
        );
      }
    }
  });

  test("draws something for every shape in every mode", () => {
    for (const shape of SHAPES) {
      const values = defaultsFor(shape);
      for (const mode of ["outline", "diagonal", "thick", "filled"] as const) {
        const mask = generate(shape, values, options({ mode, thickness: 3 }));
        expect(filledCount(mask), `${shape.id} ${mode}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the circle tickbox", () => {
  const ellipse = shapeById("ellipse");

  test("hides the x size while it is ticked", () => {
    const keys = (values: Values) =>
      visibleInputs(ellipse, values).map((input) => input.key);

    expect(keys({ circle: true, w: 31, h: 31 })).not.toContain("w");
    expect(keys({ circle: false, w: 31, h: 31 })).toContain("w");
  });

  test("makes the y size drive both axes", () => {
    const circle = generate(
      ellipse,
      { circle: true, w: 7, h: 31 },
      options({ mode: "filled" }),
    );
    const both = generate(
      ellipse,
      { circle: false, w: 31, h: 31 },
      options({ mode: "filled" }),
    );

    expect(toRows(circle)).toEqual(toRows(both));
  });
});

describe("switching shape", () => {
  test("carries over the sizes the new shape also has", () => {
    const semi = shapeById("semi");
    const carried = defaultsFor(semi, { circle: false, w: 40, h: 20 });

    expect(carried.w).toBe(40);
    expect(carried.h).toBe(20);
    expect(carried.circle).toBe(false);
    expect(carried.facing).toBe("Up");
  });

  test("drops values the new shape has no input for", () => {
    const square = shapeById("square");
    const carried = defaultsFor(square, { circle: false, w: 40, h: 20 });

    expect(carried.w).toBeUndefined();
    expect(carried.size).toBe(square.inputs[0].default);
  });
});

describe("generate", () => {
  const ellipse = shapeById("ellipse");
  const values = { circle: true, w: 31, h: 31 };

  test("closes the diagonals in mode two but not mode one", () => {
    const thin = generate(ellipse, values, options({ mode: "outline" }));
    const thick = generate(ellipse, values, options({ mode: "diagonal" }));

    expect(components(thin, 4)).toBeGreaterThan(1);
    expect(components(thick, 4)).toBe(1);
  });

  test("draws the smallest circle as a ring, not a blob", () => {
    const small = { circle: true, w: 3, h: 3 };

    expect(
      toRows(generate(ellipse, small, options({ mode: "outline", bias: 0.4 }))),
    ).toEqual(["###", "#.#", "###"]);
  });

  test("caps the wall per shape", () => {
    expect(maxThicknessFor(ellipse, values, -0.5)).toBe(15);
    expect(maxThicknessFor(shapeById("square"), { size: 20 }, -0.5)).toBe(10);
    expect(
      maxThicknessFor(shapeById("star"), { size: 41, points: 5, ratio: 0.5 }, -0.5),
    ).toBeLessThan(12);
  });
});
