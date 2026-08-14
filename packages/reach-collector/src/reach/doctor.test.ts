import { describe, expect, it, vi } from "vitest";

import { doctorAgentReach } from "./doctor.js";

describe("doctorAgentReach", () => {
  it("uses status rather than active_backend as availability truth", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        youtube: { status: "off", active_backend: "yt-dlp", message: "missing" },
        twitter: { status: "ok", active_backend: null, message: "ready" },
      }),
    });
    const result = await doctorAgentReach({ executable: "agent-reach", run });
    expect(result.channels.youtube?.available).toBe(false);
    expect(result.channels.twitter?.available).toBe(true);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["doctor", "--json"] }),
    );
  });

  it("fails closed on malformed JSON", async () => {
    const result = await doctorAgentReach({
      executable: "agent-reach",
      run: async () => ({ exitCode: 0, stdout: "not-json" }),
    });
    expect(result.available).toBe(false);
    expect(result.errorKind).toBe("invalid-output");
  });
});
