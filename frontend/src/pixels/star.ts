// Stars.
//
// Unlike an ellipse, a star's wall really is an offset polygon, so this one
// works from a distance field: for every cell, the distance to the nearest edge
// of the star, negative inside. A wall is then a band of that distance, which
// comes out an even depth the whole way round — through the notches included.

import {
  blank,
  setCell,
  wallDepth,
  type Options,
  type Rastered,
} from "./mask";

export interface Params {
  size: number;
  points: number;
  ratio: number; // inner radius as a fraction of the outer one
}

type Point = [number, number];

// Alternating outer and inner corners, starting at the top so the star points
// up. Measured from the centre of the grid.
const corners = (params: Params): Point[] => {
  const outer = params.size / 2;
  const inner = outer * params.ratio;
  const step = Math.PI / params.points;
  const points: Point[] = [];
  for (let i = 0; i < params.points * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + i * step;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return points;
};

const squaredDistanceToEdge = (
  px: number,
  py: number,
  [ax, ay]: Point,
  [bx, by]: Point,
): number => {
  const vx = bx - ax;
  const vy = by - ay;
  const length = vx * vx + vy * vy;
  let along = length > 0 ? ((px - ax) * vx + (py - ay) * vy) / length : 0;
  along = Math.max(0, Math.min(1, along));
  const dx = px - (ax + along * vx);
  const dy = py - (ay + along * vy);
  return dx * dx + dy * dy;
};

const nearestEdge = (px: number, py: number, shape: Point[]): number => {
  let nearest = Infinity;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const distance = squaredDistanceToEdge(px, py, shape[j], shape[i]);
    if (distance < nearest) nearest = distance;
  }
  return Math.sqrt(nearest);
};

// Even-odd ray cast: count the edges directly left of the point.
const isInside = (px: number, py: number, shape: Point[]): boolean => {
  let inside = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const [xi, yi] = shape[i];
    const [xj, yj] = shape[j];
    const straddles = yi > py !== yj > py;
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

// A star's wall stops at the notches between its points, not at its tips, so
// the ceiling is the distance from the centre to the nearest edge.
export const maxThickness = (params: Params, bias = 0): number => {
  const shape = corners(params);
  return Math.max(1, Math.ceil(nearestEdge(0, 0, shape) + bias));
};

export const raster = (params: Params, options: Options): Rastered => {
  const n = params.size;
  const depth = wallDepth(options);
  const shape = corners(params);

  const solid = blank(n, n);
  const ring = blank(n, n);

  for (let y = 0; y < n; y++) {
    const py = y + 0.5 - n / 2;
    for (let x = 0; x < n; x++) {
      const px = x + 0.5 - n / 2;
      const distance = nearestEdge(px, py, shape);
      const signed = isInside(px, py, shape) ? -distance : distance;
      if (signed > options.bias) continue;
      setCell(solid, x, y, 1);
      if (depth === 0 || signed > options.bias - depth) setCell(ring, x, y, 1);
    }
  }

  return { mask: ring, solid };
};
