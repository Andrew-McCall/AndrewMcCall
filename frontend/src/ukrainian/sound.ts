// A word written the way an English speaker would say it: syllables split by
// hyphens, the stressed one in capitals. Ukrainian spelling is regular, so a
// letter table is enough.

const SOUNDS: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ye", ж: "zh", з: "z",
  и: "y", і: "ee", ї: "yee", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "oo", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ю: "yu", я: "ya",
};
const VOWELS = "аеєиіїоуюя";
const ACUTE = "́";

// What the letters cannot show.
export const SOUND_KEY =
  "y in a syllable = the i of 'bit'; y before a vowel = 'yes'; i after a vowel = the y of 'boy'; " +
  "ee = 'see'; oo = 'boot'; h = a soft, voiced h; kh = the ch of 'loch'; " +
  "zh = the s of 'measure'; · keeps two sounds apart; ' = the consonant before it is soft.";

const isVowel = (letter?: string): boolean => !!letter && VOWELS.includes(letter);

// How many syllables a word has: one for each vowel.
export const syllableCount = (word: string): number =>
  [...word.toLowerCase()].filter(isVowel).length;

export const sound = (word: string): string => {
  const syllables: string[] = [];
  let current = "";
  let hasVowel = false;
  const stressed = new Set<number>();
  const letters = [...word.toLowerCase()];
  letters.forEach((letter, i) => {
    const next = letters.slice(i + 1).find((l) => l !== "ь" && l !== ACUTE);
    // «й» is the y of "yes" before a vowel and the y of "boy" after one.
    const value = letter === "й" ? (isVowel(next) ? "y" : "i") : SOUNDS[letter];
    if (letter === ACUTE) {
      stressed.add(syllables.length);
    } else if (letter === "ь") {
      current += "'";
    } else if (value) {
      const vowel = isVowel(letter);
      // A consonant before a vowel opens the next syllable.
      if (hasVowel && (vowel || isVowel(next))) {
        syllables.push(current);
        current = "";
        hasVowel = false;
      }
      // «зг» must not read as "zh", nor «сг» as "sh", nor «кг» as "kh".
      current += (value === "h" && /[zsk]$/.test(current) ? "·" : "") + value;
      hasVowel ||= vowel;
    } else if (letter === "-" && current) {
      syllables.push(current);
      current = "";
      hasVowel = false;
    }
  });
  if (current) syllables.push(current);
  return syllables.map((part, i) => (stressed.has(i) ? part.toUpperCase() : part)).join("-");
};
