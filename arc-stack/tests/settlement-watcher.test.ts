import { describe, expect, it } from "vitest";
import { deriveSportmonksConfirmation, parseSportmonksOracleReport } from "../src/oracle-adapter.js";
import { resolutionEvidenceReady } from "../src/settlement-watcher.js";

function report(finalResult: boolean) {
  return parseSportmonksOracleReport({
    data: {
      id: 19637023,
      starting_at: "2026-07-26 21:00:00",
      state: { id: finalResult ? 5 : 2, state: finalResult ? "FT" : "LIVE", short_name: finalResult ? "FT" : "LIVE" },
      scores: [
        { participant_id: 1, score: { goals: 1, participant: "home" }, description: "CURRENT" },
        { participant_id: 2, score: { goals: 0, participant: "away" }, description: "CURRENT" },
      ],
    },
    subscription: [{ name: "Trial" }],
  }, undefined, "2026-07-26T21:01:00.000Z");
}

describe("settlement scheduling boundary", () => {
  it("never schedules before close or from non-final evidence", () => {
    const provisional = report(false);
    const final = report(true);
    expect(resolutionEvidenceReady(false, final, deriveSportmonksConfirmation(final))).toBe(false);
    expect(resolutionEvidenceReady(true, provisional, deriveSportmonksConfirmation(provisional))).toBe(false);
    expect(resolutionEvidenceReady(true, final, deriveSportmonksConfirmation(final))).toBe(true);
  });
});
