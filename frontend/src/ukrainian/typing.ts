// Checks typing against the word in the book, one letter at a time.

export const norm = (text: string): string =>
  text.toLowerCase().replace(/[’ʼ`]/g, "'").replace(/\u0301/g, "");

export interface Typed {
  typed: string; // the start of the word that was typed correctly
  wrong: boolean; // something after it did not match
  done: boolean;
}

export const accept = (word: string, value: string): Typed => {
  const want = norm(word);
  const got = norm(value);
  let n = 0;
  while (n < got.length && n < want.length && got[n] === want[n]) n++;
  return { typed: word.slice(0, n), wrong: n < got.length, done: n === want.length };
};

export const blank = (form: string, shown = ""): string =>
  shown + "_".repeat(form.length - shown.length);

// Rebuilds a sentence around its words: `show` gives what stands for word i,
// `gap` what stands for the text between words.
export const weave = (
  text: string,
  words: { start: number; form: string }[],
  show: (i: number) => string,
  gap = (between: string) => between,
): string => {
  let out = "";
  let at = 0;
  words.forEach((word, i) => {
    out += gap(text.slice(at, word.start)) + show(i);
    at = word.start + word.form.length;
  });
  return out + gap(text.slice(at));
};
