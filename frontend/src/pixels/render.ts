// Drawing a cell smaller than the slot it occupies, which is what puts gaps
// between the pixels. The mask is untouched — this is purely how a cell is
// painted, so the preview, the PNG and the SVG can all agree on it.

export interface CellRect {
  size: number;
  offset: number;
}

// The square to paint for one cell, in whole pixels, centred in a slot `scale`
// pixels across. A cell never disappears entirely: at the smallest sizes it
// bottoms out at one pixel.
export const cellRect = (scale: number, pixelSize: number): CellRect => {
  const size = Math.max(1, Math.round(scale * pixelSize));
  return { size, offset: Math.floor((scale - size) / 2) };
};

// How many device pixels to give each cell on the preview canvas.
//
// At full size there is nothing to draw inside a cell, so one pixel each is
// enough and the whole mask goes down in a single putImageData. Once there are
// gaps a cell needs room for them, capped so a 512-cell grid doesn't ask for a
// canvas the size of a wall.
export const backingScale = (maxSide: number, pixelSize: number): number => {
  if (pixelSize >= 1) return 1;
  return Math.max(3, Math.min(12, Math.floor(1200 / maxSide)));
};
