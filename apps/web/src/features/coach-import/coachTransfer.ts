import {
  CoachTransferError as ContractCoachTransferError,
  extractCoachJson as extractContractCoachJson,
  parseCoachTransfer as parseContractCoachTransfer,
} from "@tenjin/exchange";

import { COACH_TRANSFER_REPAIR_PROMPT } from "./coachPrompt.js";

export {
  canonicalizeCoachTransfer,
  COACH_TRANSFER_SCHEMA,
  digestCoachTransfer,
  MAX_COACH_TRANSFER_BYTES,
} from "@tenjin/exchange";
export type {
  CoachTransfer,
  CoachTransferDigestDependencies,
  CoachTransferErrorCode,
  CoachTransferItem,
} from "@tenjin/exchange";

export class CoachTransferError extends ContractCoachTransferError {
  readonly repairPrompt = COACH_TRANSFER_REPAIR_PROMPT;

  constructor(code: ContractCoachTransferError["code"], message: string) {
    super(code, message);
    this.name = "CoachTransferError";
  }
}

function adaptContractError(error: unknown): never {
  if (error instanceof ContractCoachTransferError) {
    throw new CoachTransferError(error.code, error.message);
  }
  throw error;
}

export function extractCoachJson(input: string): string {
  try {
    return extractContractCoachJson(input);
  } catch (error) {
    return adaptContractError(error);
  }
}

export function parseCoachTransfer(
  input: string,
): ReturnType<typeof parseContractCoachTransfer> {
  try {
    return parseContractCoachTransfer(input);
  } catch (error) {
    return adaptContractError(error);
  }
}
