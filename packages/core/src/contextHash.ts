/**
 * The exact input serialisation behind a context hash.
 *
 * This is content identity, not a formatting choice: the field order is a fixed
 * literal and absent fields are omitted whole. Reordering, sorting, or emitting
 * `null` for an absent field would change every hash ever computed and orphan
 * the existing ledger.
 *
 * Deliberately NOT `canonicalJson`, which recursively sorts keys and exists only
 * to make exported package bytes stable. Never substitute one for the other.
 */
export interface ContextHashInput {
  readonly original: string;
  readonly focus?: string;
  readonly corrected?: string;
  readonly answer?: string;
  readonly imageSha256?: string;
}

export function serializeContextHashInput(input: ContextHashInput): string {
  return JSON.stringify({
    original: input.original,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    ...(input.corrected === undefined ? {} : { corrected: input.corrected }),
    ...(input.answer === undefined ? {} : { answer: input.answer }),
    ...(input.imageSha256 === undefined
      ? {}
      : { imageSha256: input.imageSha256 }),
  });
}
