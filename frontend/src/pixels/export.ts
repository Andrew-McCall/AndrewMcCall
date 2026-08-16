// Getting a finished mask out of the page: as an SVG, as a PNG, or as the row
// counts a builder actually reads off while laying blocks.

import { rows, type Mask } from "./mask";
import { cellRect } from "./render";

interface SvgOptions {
  fill?: string;
  background?: string;
  pixelSize?: number; // fraction of its cell each pixel fills; 1 leaves no gap
}

// Trims float noise: 0.30000000000000004 is not something to write into a file
// a person might open.
const tidyNumber = (value: number): number => Number(value.toFixed(4));

// One rect per horizontal run, not per cell. A 128-wide circle is a few hundred
// rects that way instead of sixteen thousand, and the file stays readable.
//
// Gaps end that: a run with space between its cells is no longer one rectangle,
// so below full size each cell is written out on its own. The viewBox still
// counts whole cells, so turning gaps on shrinks the pixels without moving them.
export const toSvg = (mask: Mask, options: SvgOptions = {}): string => {
  const fill = options.fill ?? "#000000";
  const pixelSize = options.pixelSize ?? 1;
  const parts: string[] = [];

  if (options.background) {
    parts.push(
      `  <rect x="0" y="0" width="${mask.w}" height="${mask.h}" fill="${options.background}" />`,
    );
  }

  const inset = tidyNumber((1 - pixelSize) / 2);
  const side = tidyNumber(pixelSize);

  rows(mask).forEach((runs, y) => {
    for (const [start, end] of runs) {
      if (pixelSize >= 1) {
        parts.push(
          `  <rect x="${start}" y="${y}" width="${end - start + 1}" height="1" fill="${fill}" />`,
        );
        continue;
      }
      for (let x = start; x <= end; x++) {
        parts.push(
          `  <rect x="${tidyNumber(x + inset)}" y="${tidyNumber(y + inset)}" width="${side}" height="${side}" fill="${fill}" />`,
        );
      }
    }
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${mask.w} ${mask.h}" width="${mask.w}" height="${mask.h}" shape-rendering="crispEdges">`,
    ...parts,
    "</svg>",
  ].join("\n");
};

export interface RowStat {
  y: number;
  total: number;
  runs: [number, number][];
}

// One entry per drawn row: how many cells it has and where they sit. Both the
// table on the page and the text on the clipboard are built from this, so they
// can never drift apart.
export const rowStats = (mask: Mask): RowStat[] => {
  const stats: RowStat[] = [];

  rows(mask).forEach((runs, y) => {
    if (runs.length === 0) return;
    stats.push({
      y,
      total: runs.reduce((sum, [start, end]) => sum + end - start + 1, 0),
      runs,
    });
  });

  return stats;
};

// A single cell is written as its own number. Most rows of an outline are two
// lone cells, and "1-1, 13-13" is a lot of punctuation to say "1 and 13".
export const spansOf = (row: RowStat): string[] =>
  row.runs
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    ;

// Columns padded to a common width, so the numbers stay in the same place from
// row 9 to row 10 and the eye can run straight down them.
export const rowCountText = (mask: Mask): string => {
  const stats = rowStats(mask);
  const total = stats.reduce((sum, row) => sum + row.total, 0);

  const yWidth = Math.max(1, ...stats.map((row) => String(row.y).length));
  const cellsWidth = Math.max(5, ...stats.map((row) => String(row.total).length));

  const lines = [
    `${"y".padStart(yWidth)}  ${"cells".padStart(cellsWidth)}  spans`,
    ...stats.map(
      (row) =>
        `${String(row.y).padStart(yWidth)}  ${String(row.total).padStart(cellsWidth)}  ${spansOf(row)}`,
    ),
  ];

  return [...lines, "", `Total: ${total} cells`].join("\n");
};

interface PngOptions {
  cell: number;
  fill: string;
  background?: string;
  pixelSize?: number; // fraction of its cell each pixel fills; 1 leaves no gap
}

// Drawn run by run at the chosen cell size. No smoothing is involved — every
// cell is a whole number of device pixels — so the result is exact. With gaps
// the runs come apart into cells, each one centred in the slot it would have
// filled.
export const toPngBlob = (mask: Mask, options: PngOptions): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  canvas.width = mask.w * options.cell;
  canvas.height = mask.h * options.cell;

  const context = canvas.getContext("2d")!;
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  const pixelSize = options.pixelSize ?? 1;
  const pixel = cellRect(options.cell, pixelSize);

  context.fillStyle = options.fill;
  rows(mask).forEach((runs, y) => {
    for (const [start, end] of runs) {
      if (pixelSize >= 1) {
        context.fillRect(
          start * options.cell,
          y * options.cell,
          (end - start + 1) * options.cell,
          options.cell,
        );
        continue;
      }
      for (let x = start; x <= end; x++) {
        context.fillRect(
          x * options.cell + pixel.offset,
          y * options.cell + pixel.offset,
          pixel.size,
          pixel.size,
        );
      }
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
