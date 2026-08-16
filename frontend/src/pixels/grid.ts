// The ruled grid drawn over the preview. It exists so you can find a cell's
// coordinates by counting squares, which means it has to line up with the
// shape rather than with the corner of the box.

export const GRID_FINE = "rgba(255,255,255,0.10)";
export const GRID_BOLD = "rgba(255,255,255,0.32)";

// One ruled line, drawn `offset` percent of the way into its own tile.
//
// The offset lives inside the gradient rather than in `background-position`
// because positioning a background by percentage measures from the image as
// well as from the box, which is not the plain offset it looks like.
export const line = (
  towards: "right" | "bottom",
  colour: string,
  offset: number,
): string =>
  `linear-gradient(to ${towards}, transparent ${offset}%, ${colour} ${offset}%,` +
  ` ${colour} calc(${offset}% + 1px), transparent calc(${offset}% + 1px))`;

// Where the first ruled line falls, in cells from the edge, so the grid comes
// out centred on the shape instead of on its top-left corner.
//
// An even shape has its centre on a cell boundary, so a line goes straight
// through it. An odd one has a middle cell instead, so that cell is centred
// inside a square — exactly so when the step is odd too, and within half a cell
// when it isn't, which is the best a whole-cell grid can do.
export const gridOffset = (size: number, step: number): number => {
  const centre = size / 2;
  const anchor = size % 2 === 0 ? centre : Math.round(centre - step / 2);
  return ((anchor % step) + step) % step;
};
