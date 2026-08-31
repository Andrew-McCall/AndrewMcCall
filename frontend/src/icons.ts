// Inline SVG icons for the canvas control row.
//
// These buttons used to label themselves with text glyphs — ○ clear, ↺ reset,
// ▓ static, ✕ disable, ▶ enable. None of those code points live in a normal
// monospace face, so every device substituted its own fallback font per glyph:
// not metrically matched, each with its own baseline. The buttons ended up
// different sizes with the glyph riding off-centre, differently on every
// device. ▓ (U+2593) was the worst of them, because block-element glyphs are
// drawn to fill the whole em box — in a taller fallback face it overshot the
// button's line box entirely. iOS made it worse again by pulling ▶ and ✕ into
// Apple Color Emoji and painting them as oversized colour emoji.
//
// SVG has no fallback path. The size, the baseline and the colour are ours on
// every device, which is the whole point of the change.

// Drawn on a 24x24 grid and rendered at 12px, so stroke-width 2 lands on
// exactly 1px — crisp at the size these actually appear.
const ICONS = {
  clear: `<circle cx="12" cy="12" r="8"/>`,
  reset: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`,
  // A half-filled checkerboard: the dither pattern ▓ was standing in for.
  static:
    `<g fill="currentColor" stroke="none">` +
    `<rect x="2" y="2" width="6" height="6"/><rect x="16" y="2" width="6" height="6"/>` +
    `<rect x="9" y="9" width="6" height="6"/>` +
    `<rect x="2" y="16" width="6" height="6"/><rect x="16" y="16" width="6" height="6"/>` +
    `</g>`,
  disable: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  enable: `<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>`,
  // A terminal prompt, matching the `>_` on the front page's secret-menu button.
  secret: `<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>`,
} as const;

export type IconName = keyof typeof ICONS;

// `currentColor` rather than a literal green: the row's colour and the greyed
// -out `opacity` applied to disabled buttons then carry through on their own,
// without the icon having to know about either. `aria-hidden` because the
// label beside it already says what the button does.
export const icon = (name: IconName): string =>
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"` +
  ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"` +
  ` style="flex:none">${ICONS[name]}</svg>`;

// Icon and label are always built together. The power button used to retitle
// itself by assigning `textContent`, which would silently wipe the icon out of
// the button — going through here means there is no path that writes one
// without the other. Every control's label happens to be its icon's name.
export const btnHtml = (name: IconName): string =>
  `${icon(name)}<span>${name}</span>`;
