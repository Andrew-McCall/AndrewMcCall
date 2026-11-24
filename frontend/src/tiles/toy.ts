export type Rng = () => number;

export const rng = (seed: number): Rng => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface ToyHost {
  win: HTMLElement;
  body: HTMLElement;
  signal: AbortSignal;
  wide(): boolean;
  visible(): boolean;
  onSeed(use: (seed: number) => void): void;
  frame(tick: (time: number) => void): void;
  every(ms: number, tick: () => void): () => void;
  later(ms: number, run: () => void): void;
}

export type Toy = (host: ToyHost) => void;
