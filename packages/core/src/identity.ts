const KATAKANA_TO_HIRAGANA_OFFSET = 0x60;

function katakanaCharacterToHiragana(character: string): string {
  return String.fromCodePoint(
    character.codePointAt(0)! - KATAKANA_TO_HIRAGANA_OFFSET,
  );
}

export function normalizeIdentity(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .replace(/[A-Z]/gu, (character) => character.toLowerCase())
    .replace(/[\u30a1-\u30f6\u30fd-\u30fe]/gu, katakanaCharacterToHiragana);
}
