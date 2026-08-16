// The shape table. Every entry declares its own controls, so the page renders
// them rather than hard-coding a block of markup per shape.

import { closeDiagonals, tidy, trim, type Mask, type Options } from "./mask";
import * as ellipse from "./ellipse";
import * as square from "./square";
import * as star from "./star";

export type Value = number | string | boolean;
export type Values = Record<string, Value>;

export interface Input {
  key: string;
  label: string;
  type: "int" | "choice" | "bool" | "ratio";
  default: Value;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  hint?: string;
  // Shown only while these values match. A plain key/value match is all this
  // ever needs to do — it exists to hide a field behind a tickbox.
  showIf?: Values;
}

export interface Shape {
  id: string;
  label: string;
  smoothing: boolean;
  inputs: Input[];
  build: (values: Values, options: Options) => Mask;
  maxThickness: (values: Values, bias: number) => number;
}

export interface GenerateOptions extends Options {
  tidy: boolean;
}

const num = (values: Values, key: string): number => Number(values[key]);
const text = (values: Values, key: string): string => String(values[key]);

// Both axes come from Y Size while Circle is ticked, which is the whole of
// "a circle is an ellipse with one input".
const axes = (values: Values): { w: number; h: number } => ({
  w: values.circle ? num(values, "h") : num(values, "w"),
  h: num(values, "h"),
});

const sizeInputs = (): Input[] => [
  { key: "circle", label: "Circle", type: "bool", default: true },
  {
    key: "w",
    label: "X Size",
    type: "int",
    default: 31,
    min: 3,
    max: 512,
    showIf: { circle: false },
  },
  { key: "h", label: "Y Size", type: "int", default: 31, min: 3, max: 512 },
];

// The ring and the solid shape come back together; mode 2 needs the solid one
// to work out which way is inward.
const withMode = (
  { mask, solid }: { mask: Mask; solid: Mask },
  options: Options,
): Mask => (options.mode === "diagonal" ? closeDiagonals(mask, solid) : mask);

export const SHAPES: Shape[] = [
  {
    id: "ellipse",
    label: "Ellipse",
    smoothing: true,
    inputs: sizeInputs(),
    build: (values, options) =>
      withMode(ellipse.raster(axes(values), options), options),
    maxThickness: (values, bias) => ellipse.maxThickness(axes(values), bias),
  },
  {
    id: "semi",
    label: "Semi Circle",
    smoothing: true,
    inputs: [
      ...sizeInputs(),
      {
        key: "facing",
        label: "Facing",
        type: "choice",
        default: "Up",
        options: ["Up", "Down", "Left", "Right"],
        hint: "Where the curved side points",
      },
    ],
    build: (values, options) =>
      withMode(
        ellipse.raster(
          { ...axes(values), portion: "half", facing: text(values, "facing") },
          options,
        ),
        options,
      ),
    maxThickness: (values, bias) => ellipse.maxThickness(axes(values), bias),
  },
  {
    id: "quarter",
    label: "Quarter Circle",
    smoothing: true,
    inputs: [
      ...sizeInputs(),
      {
        key: "corner",
        label: "Corner",
        type: "choice",
        default: "TL",
        options: ["TL", "TR", "BL", "BR"],
        hint: "Which quarter to keep",
      },
    ],
    build: (values, options) =>
      withMode(
        ellipse.raster(
          { ...axes(values), portion: "quarter", corner: text(values, "corner") },
          options,
        ),
        options,
      ),
    maxThickness: (values, bias) => ellipse.maxThickness(axes(values), bias),
  },
  {
    id: "square",
    label: "Square",
    smoothing: false,
    inputs: [
      { key: "size", label: "Size", type: "int", default: 21, min: 1, max: 512 },
    ],
    build: (values, options) =>
      withMode(square.raster({ size: num(values, "size") }, options), options),
    maxThickness: (values) => square.maxThickness({ size: num(values, "size") }),
  },
  {
    id: "star",
    label: "Star",
    smoothing: true,
    inputs: [
      { key: "size", label: "Size", type: "int", default: 41, min: 5, max: 256 },
      { key: "points", label: "Points", type: "int", default: 5, min: 3, max: 12 },
      {
        key: "ratio",
        label: "Inner ratio",
        type: "ratio",
        default: 0.5,
        min: 0.2,
        max: 0.9,
        step: 0.05,
      },
    ],
    build: (values, options) =>
      withMode(
        star.raster(
          {
            size: num(values, "size"),
            points: num(values, "points"),
            ratio: num(values, "ratio"),
          },
          options,
        ),
        options,
      ),
    maxThickness: (values, bias) =>
      star.maxThickness(
        {
          size: num(values, "size"),
          points: num(values, "points"),
          ratio: num(values, "ratio"),
        },
        bias,
      ),
  },
];

export const shapeById = (id: string): Shape =>
  SHAPES.find((shape) => shape.id === id) ?? SHAPES[0];

export const visibleInputs = (shape: Shape, values: Values): Input[] =>
  shape.inputs.filter(
    (input) =>
      !input.showIf ||
      Object.entries(input.showIf).every(([key, want]) => values[key] === want),
  );

// Starting values for a shape. Anything the previous shape had under the same
// key is kept, so changing shape doesn't throw away the size you just set.
export const defaultsFor = (shape: Shape, carryOver: Values = {}): Values => {
  const values: Values = {};
  for (const input of shape.inputs) {
    values[input.key] =
      input.key in carryOver ? carryOver[input.key] : input.default;
  }
  return values;
};

export const maxThicknessFor = (
  shape: Shape,
  values: Values,
  bias: number,
): number => shape.maxThickness(values, bias);

// Trimmed last, after every pass that can change which cells are drawn, so the
// mask that comes out is exactly the shape and nothing else.
export const generate = (
  shape: Shape,
  values: Values,
  options: GenerateOptions,
): Mask => {
  const mask = shape.build(values, options);
  return trim(options.tidy ? tidy(mask) : mask);
};
