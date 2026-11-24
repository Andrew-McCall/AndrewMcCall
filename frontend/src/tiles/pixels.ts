const lit = (rows: string[], x: number, y: number): boolean => rows[y]?.[x] === "#";

export function shade(rows: string[]): string[] {
  const span = rows.length + rows[0].length - 2;
  return rows.map((row, y) =>
    [...row]
      .map((cell, x) => {
        if (cell !== "#") return ".";
        const light = (x + y) / span;
        const edge = !lit(rows, x, y + 1) || !lit(rows, x + 1, y);
        if (light < 0.34) return "h";
        return light > 0.66 || (edge && light > 0.45) ? "l" : "m";
      })
      .join(""),
  );
}

export const pixelHtml = (rows: string[]): string =>
  shade(rows)
    .join("")
    .replace(/./g, (tone) => (tone === "." ? "<i></i>" : `<i class="${tone}"></i>`));
