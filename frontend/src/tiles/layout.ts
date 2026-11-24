export type Rect = [x: number, y: number, width: number, height: number];
export type Mode = "dwindle" | "grid";

export const MODES: Mode[] = ["dwindle", "grid"];

function dwindle(count: number, x: number, y: number, width: number, height: number, out: Rect[]): void {
  if (count === 1) {
    out.push([x, y, width, height]);
    return;
  }
  if (width > height * 1.15) {
    out.push([x, y, width / 2, height]);
    dwindle(count - 1, x + width / 2, y, width / 2, height, out);
  } else {
    out.push([x, y, width, height / 2]);
    dwindle(count - 1, x, y + height / 2, width, height / 2, out);
  }
}

function grid(count: number, width: number, height: number): Rect[] {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const out: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const inRow = row === rows - 1 ? count - row * columns : columns;
    out.push([((i % columns) * width) / inRow, (row * height) / rows, width / inRow, height / rows]);
  }
  return out;
}

export function tile(count: number, width: number, height: number, mode: Mode): Rect[] {
  if (count === 0) return [];
  if (mode === "grid") return grid(count, width, height);
  const out: Rect[] = [];
  dwindle(count, 0, 0, width, height, out);
  return out;
}

export const windowLimit = (viewportWidth: number): number => {
  if (viewportWidth >= 1400 || viewportWidth < 768) return Infinity;
  if (viewportWidth >= 1200) return 10;
  if (viewportWidth >= 992) return 8;
  return 6;
};

export function neighbour(
  rects: Record<string, Rect>,
  from: string,
  dx: number,
  dy: number,
): string | undefined {
  const here = rects[from];
  if (!here) return undefined;
  const cx = here[0] + here[2] / 2;
  const cy = here[1] + here[3] / 2;
  let best: string | undefined;
  let bestScore = Infinity;
  for (const [app, rect] of Object.entries(rects)) {
    if (app === from) continue;
    const ox = rect[0] + rect[2] / 2 - cx;
    const oy = rect[1] + rect[3] / 2 - cy;
    const along = ox * dx + oy * dy;
    if (along <= 1) continue;
    const score = along + (Math.abs(ox * dy) + Math.abs(oy * dx)) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = app;
    }
  }
  return best;
}
