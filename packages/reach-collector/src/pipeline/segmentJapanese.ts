export interface SegmentJapaneseOptions {
  readonly maximumCharacters?: number;
  readonly minimumCharacters?: number;
}

const DEFAULT_MAXIMUM_CHARACTERS = 280;
const DEFAULT_MINIMUM_CHARACTERS = 2;
const SENTENCE_END = /[。！？!?]/u;
const SOFT_BREAK = /[、，,；;：:\s]/u;

function normalizeInput(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

function splitLongSegment(value: string, maximumCharacters: number): string[] {
  const characters = [...value];
  const results: string[] = [];
  let start = 0;

  while (start < characters.length) {
    const hardEnd = Math.min(start + maximumCharacters, characters.length);
    if (hardEnd === characters.length) {
      results.push(characters.slice(start).join("").trim());
      break;
    }

    const minimumSoftBreak = start + Math.floor(maximumCharacters * 0.55);
    let end = hardEnd;
    for (let index = hardEnd - 1; index >= minimumSoftBreak; index -= 1) {
      if (SOFT_BREAK.test(characters[index]!)) {
        end = index + 1;
        break;
      }
    }
    results.push(characters.slice(start, end).join("").trim());
    start = end;
  }

  return results.filter((segment) => segment.length > 0);
}

/**
 * Deterministically cuts Japanese prose without relying on locale-sensitive
 * tokenizers. Sentence punctuation stays attached to the preceding segment.
 */
export function segmentJapanese(
  value: string,
  options: SegmentJapaneseOptions = {},
): readonly string[] {
  const maximumCharacters =
    options.maximumCharacters ?? DEFAULT_MAXIMUM_CHARACTERS;
  const minimumCharacters =
    options.minimumCharacters ?? DEFAULT_MINIMUM_CHARACTERS;
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 8) {
    throw new RangeError("maximumCharacters must be an integer of at least 8");
  }
  if (
    !Number.isSafeInteger(minimumCharacters) ||
    minimumCharacters < 1 ||
    minimumCharacters > maximumCharacters
  ) {
    throw new RangeError(
      "minimumCharacters must be a positive integer no larger than maximumCharacters",
    );
  }

  const input = normalizeInput(value);
  if (input.length === 0) {
    return [];
  }

  const sentences: string[] = [];
  let current = "";
  for (const character of input) {
    current += character;
    if (SENTENCE_END.test(character) || character === "\n") {
      const candidate = current.trim();
      if (candidate.length > 0) {
        sentences.push(candidate);
      }
      current = "";
    }
  }
  if (current.trim().length > 0) {
    sentences.push(current.trim());
  }

  return sentences
    .flatMap((sentence) => splitLongSegment(sentence, maximumCharacters))
    .filter((sentence) => [...sentence].length >= minimumCharacters);
}
