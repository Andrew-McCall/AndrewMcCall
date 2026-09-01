// These assertions pin the two properties the control-row icons exist for, so
// neither can be lost to a tidy-up later:
//
//   * every icon inherits its colour, because the row greys itself out by
//     setting `opacity` and colour on the button, never on the icon;
//   * the icon and the label are inseparable, because the power button
//     retitles itself on every click and used to wipe the icon doing it.
//
// Hard assertions rather than a snapshot: a snapshot would let either
// regression be blessed by rerunning with -u.

import { describe, expect, it } from "vitest";
import { btnHtml, icon, type IconName } from "./icons";

const NAMES: IconName[] = [
  "clear",
  "reset",
  "static",
  "disable",
  "enable",
  "secret",
  "pencil",
  "eye",
];

describe("icon", () => {
  it.each(NAMES)("%s draws an svg with no text glyph", (name) => {
    const svg = icon(name);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // The bug being fixed: any glyph here is a font-fallback risk again.
    expect(svg).not.toMatch(/[^\x00-\x7F]/);
  });

  it.each(NAMES)("%s inherits colour rather than hard-coding it", (name) => {
    const svg = icon(name);
    expect(svg).toContain("currentColor");
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it.each(NAMES)("%s is hidden from screen readers", (name) => {
    expect(icon(name)).toContain('aria-hidden="true"');
  });

  it("renders at the label's 12px, so the two line up", () => {
    expect(icon("clear")).toContain('width="12" height="12"');
    expect(icon("clear")).toContain('stroke-width="2"');
  });

  // The notes toggle asks for 20px. The stroke scales with it, so the line
  // stays 1px on screen rather than thickening with the icon.
  it("keeps the stroke a pixel wide at any size", () => {
    const svg = icon("pencil", 20);
    expect(svg).toContain('width="20" height="20"');
    expect(svg).toContain('stroke-width="1.2"');
  });
});

describe("btnHtml", () => {
  // Only the control row pairs an icon with a written label; the notes toggle
  // is the icon alone.
  const CONTROLS = NAMES.filter((n) => n !== "pencil" && n !== "eye");

  it.each(CONTROLS)("%s carries both the icon and the label", (name) => {
    const html = btnHtml(name);
    expect(html).toContain("<svg");
    expect(html).toContain(`<span>${name}</span>`);
  });

  // The power button swaps between these two on every click. Both sides of
  // that toggle have to keep an icon, which is what regressed before.
  it("keeps an icon on both sides of the power toggle", () => {
    for (const name of ["disable", "enable"] as const) {
      expect(btnHtml(name)).toContain("<svg");
    }
  });
});
