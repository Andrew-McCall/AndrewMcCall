// Getting a finished mask out of the page: as an SVG, as a PNG, or as the row
// counts a builder actually reads off while laying blocks.

import { rows, type Mask } from "./mask";

interface SvgOptions {
  fill?: string;
  background?: string;
}

// One rect per horizontal run, not per cell. A 128-wide circle is a few hundred
// rects that way instead of sixteen thousand, and the file stays readable.
export const toSvg = (mask: Mask, options: SvgOptions = {}): string => {
  const fill = options.fill ?? "#000000";
  const parts: string[] = [];

  if (options.background) {
    parts.push(
      `  <rect x="0" y="0" width="${mask.w}" height="${mask.h}" fill="${options.background}" />`,
    );
  }

  rows(mask).forEach((runs, y) => {
    for (const [start, end] of runs) {
      parts.push(
        `  <rect x="${start}" y="${y}" width="${end - start + 1}" height="1" fill="${fill}" />`,
      );
    }
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${mask.w} ${mask.h}" width="${mask.w}" height="${mask.h}" shape-rendering="crispEdges">`,
    ...parts,
    "</svg>",
  ].join("\n");
};

export const rowCountText = (mask: Mask): string => {
  const lines: string[] = [];
  let total = 0;

  rows(mask).forEach((runs, y) => {
    if (runs.length === 0) return;
    const counts = runs.map(([start, end]) => end - start + 1);
    const spans = runs.map(([start, end]) => `x ${start}-${end}`);
    total += counts.reduce((sum, count) => sum + count, 0);
    lines.push(`y=${y}: ${counts.join(" + ")} (${spans.join(", ")})`);
  });

  return [...lines, "", `Total: ${total} cells`].join("\n");
};

interface PngOptions {
  cell: number;
  fill: string;
  background?: string;
}

// Drawn run by run at the chosen cell size. No smoothing is involved — every
// cell is a whole number of device pixels — so the result is exact.
export const toPngBlob = (mask: Mask, options: PngOptions): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  canvas.width = mask.w * options.cell;
  canvas.height = mask.h * options.cell;

  const context = canvas.getContext("2d")!;
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.fillStyle = options.fill;
  rows(mask).forEach((runs, y) => {
    for (const [start, end] of runs) {
      context.fillRect(
        start * options.cell,
        y * options.cell,
        (end - start + 1) * options.cell,
        options.cell,
      );
    }
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode the PNG"));
    }, "image/png");
  });
};

export const download = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};
