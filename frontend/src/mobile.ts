// Shared mobile/desktop detection (previously inline in secret_index.ts).

// True on a real pointer device: hover + fine pointer, and no touch. Evaluated
// at call time so it reflects the current input capabilities.
export const isDesktop = (): boolean =>
  window.matchMedia("(any-hover: hover)").matches &&
  window.matchMedia("(any-pointer: fine)").matches &&
  !("ontouchstart" in window && navigator.maxTouchPoints > 0);

export const isMobile = (): boolean => !isDesktop();
