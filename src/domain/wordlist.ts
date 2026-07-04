import * as Effect from "effect/Effect";
import { WordlistExhausted } from "./errors.js";

const starts = [
  "ash",
  "bay",
  "bee",
  "bir",
  "blu",
  "bud",
  "cal",
  "ced",
  "clo",
  "cob",
  "cor",
  "cot",
  "dew",
  "dov",
  "elm",
  "fen",
  "fir",
  "fox",
  "gem",
  "glad",
  "glen",
  "gold",
  "har",
  "haz",
  "hill",
  "ivy",
  "jade",
  "jun",
  "kind",
  "lake",
  "leaf",
  "lime",
  "lark",
  "map",
  "mint",
  "moon",
  "moss",
  "nova",
  "oak",
  "opal",
  "pearl",
  "pine",
  "rain",
  "reed",
  "rose",
  "sage",
  "sky",
  "snow",
  "star",
  "sun",
  "vale",
  "wave",
  "will",
  "wind",
];

const ends = [
  "able",
  "beam",
  "bell",
  "bend",
  "bird",
  "bloom",
  "brook",
  "bud",
  "calm",
  "cove",
  "crest",
  "dale",
  "dawn",
  "drift",
  "field",
  "flare",
  "flow",
  "ford",
  "gate",
  "glow",
  "grove",
  "haven",
  "heart",
  "hill",
  "kind",
  "lane",
  "light",
  "mark",
  "mead",
  "mere",
  "mist",
  "path",
  "pond",
  "rise",
  "root",
  "shade",
  "shine",
  "song",
  "spring",
  "stone",
  "stream",
  "trail",
  "vale",
  "view",
  "ward",
  "well",
  "wood",
  "worth",
  "yard",
];

const generated = starts.flatMap((start) => ends.map((end) => `${start}${end}`));

export const WORDS = Array.from(
  new Set(generated.filter((word) => /^[a-z]{3,8}$/.test(word))),
).slice(0, 1024);

export const pickWord = Effect.fn("wordlist.pickWord")(function* (
  collides: (word: string) => boolean | Effect.Effect<boolean>,
) {
  for (const word of WORDS) {
    const result = collides(word);
    const collision = yield* Effect.isEffect(result)
      ? (result as Effect.Effect<boolean>)
      : Effect.succeed(result);
    if (!collision) {
      return word;
    }
  }
  return yield* new WordlistExhausted();
});
