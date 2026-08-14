import type { RawSourceItemV1 } from "../contracts/rawSourceItem.js";

export const JAPANESE_FILTER_RULE_VERSION = "ja-script-v1" as const;

export type JapaneseFilterDecision =
  | "eligible"
  | "needs_review"
  | "skipped_non_japanese";

export interface JapaneseScriptClassificationV1 {
  readonly ruleVersion: typeof JAPANESE_FILTER_RULE_VERSION;
  readonly decision: JapaneseFilterDecision;
  readonly japaneseCharacters: number;
  readonly kanaCharacters: number;
  readonly unicodeLetters: number;
  readonly japaneseLetterRatio: number;
}

export interface ClassifiedSourceItemV1 {
  readonly item: RawSourceItemV1;
  readonly text: string;
  readonly classification: JapaneseScriptClassificationV1;
}

const HIRAGANA = /\p{Script=Hiragana}/u;
const KATAKANA = /\p{Script=Katakana}/u;
const HAN = /\p{Script=Han}/u;
const LETTER = /\p{Letter}/u;

/** Fixed V0 classifier: deterministic and intentionally conservative. */
export function classifyJapanese(
  value: string,
): JapaneseScriptClassificationV1 {
  let kanaCharacters = 0;
  let japaneseCharacters = 0;
  let unicodeLetters = 0;

  for (const character of value.normalize("NFKC")) {
    const isKana = HIRAGANA.test(character) || KATAKANA.test(character);
    const isJapanese = isKana || HAN.test(character);
    if (isKana) {
      kanaCharacters += 1;
    }
    if (isJapanese) {
      japaneseCharacters += 1;
    }
    if (LETTER.test(character)) {
      unicodeLetters += 1;
    }
  }

  const japaneseLetterRatio =
    unicodeLetters === 0 ? 0 : japaneseCharacters / unicodeLetters;
  const decision: JapaneseFilterDecision =
    japaneseCharacters >= 8 &&
    kanaCharacters >= 2 &&
    japaneseLetterRatio >= 0.35
      ? "eligible"
      : japaneseCharacters >= 6
        ? "needs_review"
        : "skipped_non_japanese";

  return {
    ruleVersion: JAPANESE_FILTER_RULE_VERSION,
    decision,
    japaneseCharacters,
    kanaCharacters,
    unicodeLetters,
    japaneseLetterRatio,
  };
}

export function sourceItemText(item: RawSourceItemV1): string {
  const { content } = item;
  if (content.kind === "article" || content.kind === "post") {
    return [content.title, content.text].filter(Boolean).join("\n");
  }
  return [
    content.title,
    content.description,
    ...(content.transcript?.map((cue) => cue.text) ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

export function classifySourceItem(
  item: RawSourceItemV1,
): ClassifiedSourceItemV1 {
  const text = sourceItemText(item);
  return { item, text, classification: classifyJapanese(text) };
}

export function filterJapaneseItems(
  items: readonly RawSourceItemV1[],
  decisions: ReadonlySet<JapaneseFilterDecision> = new Set(["eligible"]),
): readonly RawSourceItemV1[] {
  return items.filter((item) =>
    decisions.has(classifyJapanese(sourceItemText(item)).decision),
  );
}
