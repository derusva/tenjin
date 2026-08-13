// @vitest-environment node

import { describe, expect, it } from "vitest";

import { COACH_TRANSFER_REPAIR_PROMPT } from "./coachPrompt.js";
import {
  CoachTransferError,
  extractCoachJson,
  parseCoachTransfer,
  type CoachTransferErrorCode,
} from "./coachTransfer.js";

const ITEM = {
  type: "lookup",
  focus: "手を打つ",
  sourceExcerpt: "大丈夫、手は打ったから。",
  answer: "采取措施；这里表示已经采取了对策。",
} as const;

const RAW_TRANSFER = JSON.stringify({
  schema: "tenjin.coach-transfer/v1",
  items: [ITEM],
});

function expectFacadeError(
  action: () => unknown,
  expectedCode: CoachTransferErrorCode,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CoachTransferError);
    const transferError = error as CoachTransferError;
    expect(transferError.name).toBe("CoachTransferError");
    expect(transferError.code).toBe(expectedCode);
    expect(transferError.repairPrompt).toBe(COACH_TRANSFER_REPAIR_PROMPT);
    return;
  }
  throw new Error(`Expected ${expectedCode}`);
}

describe("Coach transfer web facade", () => {
  it("delegates successful parsing to the exchange contract", () => {
    expect(parseCoachTransfer(RAW_TRANSFER)).toEqual({
      schema: "tenjin.coach-transfer/v1",
      items: [ITEM],
    });
  });

  it("delegates successful fenced JSON extraction", () => {
    expect(
      extractCoachJson(`\`\`\`json\n${RAW_TRANSFER}\n\`\`\``),
    ).toBe(RAW_TRANSFER);
  });

  it.each([
    ["parseCoachTransfer", () => parseCoachTransfer("{not json}")],
    ["extractCoachJson", () => extractCoachJson("not json")],
  ] as const)("adapts %s contract failures for Coach repair", (name, action) => {
    expectFacadeError(
      action,
      name === "parseCoachTransfer" ? "INVALID_JSON" : "INVALID_ENVELOPE",
    );
  });
});
