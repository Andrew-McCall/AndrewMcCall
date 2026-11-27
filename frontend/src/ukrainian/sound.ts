// A word written the way an English speaker would say it: syllables split by
// hyphens, the stressed one in capitals. Ukrainian spelling is regular, so a
// letter table is enough.

const SOUNDS: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ye", ж: "zh", з: "z",
  и: "y", і: "ee", ї: "yee", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "oo", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ю: "yu", я: "ya",
};
const VOWELS = "аеєиіїоуюя";
const ACUTE = "́";

// What the letters cannot show.
export const SOUND_KEY =
  "y alone = the i of 'bit'; ee = 'see'; oo = 'boot'; h = a soft, voiced h; " +
  "kh = the ch of 'loch'; zh = the s of 'measure'; ' = the consonant before it is soft.";

export const sound = (word: string): string => {
  const syllables: string[] = [];
  let current = "";
  let hasVowel = false;
  let stressed = -1;
  const letters = [...word.toLowerCase()];
  letters.forEach((letter, i) => {
    if (letter === ACUTE) {
      stressed = syllables.length;
    } else if (letter === "ь") {
      current += "'";
    } else if (letter in SOUNDS) {
      const vowel = VOWELS.includes(letter);
      // A consonant before a vowel opens the next syllable.
      const next = letters.slice(i + 1).find((l) => l !== "ь" && l !== ACUTE);
      const opens = hasVowel && (vowel || (next !== undefined && VOWELS.includes(next)));
      if (opens) {
        syllables.push(current);
        current = "";
        hasVowel = false;
      }
      current += SOUNDS[letter];
      hasVowel ||= vowel;
    } else if (letter === "-" && current) {
      syllables.push(current);
      current = "";
      hasVowel = false;
    }
  });
  if (current) syllables.push(current);
  return syllables.map((part, i) => (i === stressed ? part.toUpperCase() : part)).join("-");
};
