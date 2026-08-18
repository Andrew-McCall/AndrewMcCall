// The heading outline, taken from the same parse the renderer uses — so the
// anchors in a table of contents can never disagree with the ids in the body.

import { headingId } from "./inline";
import type { Block } from "./block";

export interface Heading {
  level: number;
  /** Raw heading text; inline markup is not applied. */
  text: string;
  /** Matches the `id` the renderer puts on the heading element. */
  id: string;
}

export const outline = (blocks: Block[]): Heading[] =>
  blocks
    .filter((b): b is Extract<Block, { kind: "heading" }> => b.kind === "heading")
    .map((b) => ({ level: b.level, text: b.text, id: headingId(b.text) }));
