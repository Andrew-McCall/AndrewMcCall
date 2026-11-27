// The standard Ukrainian layout on an ISO keyboard, by physical key. The page
// types from this table, so the system layout does not have to be Ukrainian.

import { norm } from "./typing";

export interface Key {
  code: string;
  uk: string;
  en: string;
  finger: number; // 0 left little finger … 7 right little finger
}

const CODES: Record<string, string> = {
  "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight",
  ";": "Semicolon", "'": "Quote", "#": "Backslash", "\\": "IntlBackslash", ",": "Comma",
  ".": "Period", "/": "Slash",
};

const code = (en: string): string =>
  CODES[en] ?? (/\d/.test(en) ? `Digit${en}` : `Key${en.toUpperCase()}`);

// `lead` is how many keys sit left of the first finger column.
const row = (en: string, uk: string, lead: number): Key[] =>
  [...en].map((key, i) => ({
    code: code(key),
    uk: uk[i],
    en: key,
    finger: [0, 1, 2, 3, 3, 4, 4, 5, 6, 7][Math.min(Math.max(i - lead, 0), 9)],
  }));

export const ROWS: Key[][] = [
  row("`1234567890-=", "'1234567890-=", 1),
  row("qwertyuiop[]", "йцукенгшщзхї", 0),
  row("asdfghjkl;'#", "фівапролджєґ", 0),
  row("\\zxcvbnm,./", "ґячсмитьбю.", 1),
];

export const FINGERS = [
  "left little finger", "left ring finger", "left middle finger", "left index finger",
  "right index finger", "right middle finger", "right ring finger", "right little finger",
];

const KEYS = ROWS.flat();

// Digits stay with the system layout.
export const charFor = (keyCode: string): string | undefined =>
  KEYS.find((key) => key.code === keyCode && !/\d/.test(key.uk))?.uk;

export const keyFor = (char: string): Key | undefined =>
  KEYS.find((key) => key.uk === norm(char));

// False for a word with a letter the layout does not have (Russian «ы», Latin).
// A stress mark is not a letter, so it does not count.
export const canType = (word: string): boolean => [...norm(word)].every(keyFor);
