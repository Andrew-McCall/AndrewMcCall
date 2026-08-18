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
//
// The square and its slot have to share a parity, or the leftover margin is an
// odd number of pixels and cannot be split evenly — which would sit every cell
// a pixel off centre and lean the whole shape one way. So the nearest size with
// the right parity wins, rather than simply the nearest size.
export const cellRect = (scale: number, pixelSize: number): CellRect => {
  const ideal = scale * pixelSize;
  let size = Math.min(scale, Math.max(1, Math.round(ideal)));

  if ((scale - size) % 2 !== 0) {
    const smaller = size - 1;
    const larger = size + 1;
    if (smaller >= 1 && larger <= scale) {
      size = Math.abs(ideal - smaller) <= Math.abs(ideal - larger) ? smaller : larger;
    } else {
      size = smaller >= 1 ? smaller : larger;
    }
  }

  return { size, offset: (scale - size) / 2 };
};

// How many device pixels to give each cell on the preview canvas.
//
// At full size there is nothing to draw inside a cell, so one pixel each is
// enough and the whole mask goes down in a single putImageData. Once there are
// gaps a cell needs room for them, capped so a 512-cell grid doesn't ask for a
// canvas the size of a wall.
export const backingScale = (maxSide: number, pixelSize: number): number => {
  if (pixelSize >= 1) return 1;
  // Room to spare, because a centred square has to share its slot's parity —
  // so only every second size is available and a cramped slot has few to offer.
  return Math.max(3, Math.min(16, Math.floor(1200 / maxSide)));
};
