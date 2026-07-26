// Shared mobile/desktop detection (previously inline in secret_index.ts).

// True on a real pointer device with a wide enough viewport: hover + fine
// pointer, no touch, and >480px wide. Evaluated at call time so it reflects the
// current input capabilities and window size.
export const isDesktop = (): boolean =>
  window.innerWidth > 480 &&
  window.matchMedia("(any-hover: hover)").matches &&
  window.matchMedia("(any-pointer: fine)").matches &&
  !("ontouchstart" in window && navigator.maxTouchPoints > 0);

export const isMobile = (): boolean => !isDesktop();
