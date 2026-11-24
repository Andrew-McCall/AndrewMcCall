export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

export const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] =>
  [...root.querySelectorAll<T>(selector)];

export const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

export const calm = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;
