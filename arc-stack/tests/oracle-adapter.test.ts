import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORACLE_ADAPTERS,
  adapterRegistration,
  parseSportmonksOracleReport,
  parseOracleSse,
  parseTxlineScoreSseReport,
  parseTxlineScoreSseReports,
  parseTxlineOracleReport,
  reduceOracleReports,
  validateOracleReport,
  verifySportmonksFixture,
} from "../src/oracle-adapter.js";

function txline(sequence: number, correction = 0, score: [number, number] = [1, 0]) {
  return {
    success: true,
    data: {
      fixtureId: "18257865",
      status: "final",
      homeScore: score[0],
      awayScore: score[1],
      winner: score[0] > score[1] ? "part1" : score[0] === score[1] ? "draw" : "part2",
      sourceUpdateId: String(sequence),
      sourceTimestamp: `2026-07-23T12:00:${String(sequence).padStart(2, "0")}.000Z`,
      sequence,
      correction,
      proof: { merkleRoot: `root-${sequence}` },
    },
  };
}

describe("OracleAdapterV1", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the six mandatory evidence fields", () => {
    const raw = JSON.stringify(txline(1));
    const report = parseTxlineOracleReport(JSON.parse(raw), raw, "2026-07-23T12:00:02.000Z");
    expect(report).toMatchObject({
      rawResponse: raw,
      fixtureIdentity: "18257865",
      sequence: 1n,
      timestamp: "2026-07-23T12:00:01.000Z",
      proof: { kind: "TXLINE_AUTHENTICATED_HTTPS", txlineProof: { merkleRoot: "root-1" } },
    });
    expect(report.rawPayloadHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts the production TxLINE null metadata shape and derives a stable sequence", () => {
    const payload = {
      success: true as const,
      data: {
        fixtureId: "18257865", status: "final", homeScore: 4, awayScore: 6, winner: "part2" as const,
        sourceUpdateId: "1093:1194", sourceTimestamp: "2026-07-18T23:01:43.008Z",
        sequence: null, correction: null, source: "txline", proof: null, settlementRule: null,
      },
    };
    const report = parseTxlineOracleReport(payload);
    expect(report).toMatchObject({ sequence: 10_931_194n, correctionRank: 0, normalizedOutcome: 2 });
  });

  it("reduces duplicates, reorders, and corrections to one identical state", () => {
    const reports = [
      parseTxlineOracleReport(txline(1)),
      parseTxlineOracleReport(txline(2)),
      parseTxlineOracleReport(txline(2, 1, [2, 0])),
      parseTxlineOracleReport(txline(1)),
    ];
    const forward = reduceOracleReports(reports);
    const reverse = reduceOracleReports([...reports].reverse());
    expect(forward?.reportHash).toBe(reverse?.reportHash);
    expect(forward).toMatchObject({ sequence: 2n, correctionRank: 1, homeScore: 2, normalizedOutcome: 0 });
  });

  it("normalizes an authenticated Sportmonks witness independently", () => {
    const report = parseSportmonksOracleReport({
      data: {
        id: 9901,
        state: { short_name: "FT" },
        participants: [],
        scores: [
          { description: "CURRENT", score: { participant: "home", goals: 1 } },
          { description: "CURRENT", score: { participant: "away", goals: 0 } },
        ],
      },
      subscription: [{ type: "trial" }],
    }, undefined, "2026-07-23T12:00:03.000Z");
    expect(report).toMatchObject({
      adapterId: ORACLE_ADAPTERS.SPORTMONKS_V1,
      fixtureIdentity: "9901",
      finalResult: true,
      normalizedOutcome: 0,
    });
  });

  it("reserves future Pyth and election identifiers as explicitly disabled", () => {
    expect(adapterRegistration(ORACLE_ADAPTERS.PYTH_V1)).toMatchObject({ enabled: false, role: "RESERVED" });
    expect(adapterRegistration(ORACLE_ADAPTERS.ELECTION_V1)).toMatchObject({ enabled: false, role: "RESERVED" });
  });

  it("rejects malformed evidence, cross-fixture reports, and non-final reports", () => {
    const valid = parseTxlineOracleReport(txline(3));
    expect(() => validateOracleReport(valid, {
      adapterId: ORACLE_ADAPTERS.TXLINE_V1, fixtureIdentity: "different-fixture", requireFinal: true,
    })).toThrow("oracle_fixture_identity_mismatch");
    expect(() => validateOracleReport({ ...valid, rawResponse: "tampered" }, {
      adapterId: ORACLE_ADAPTERS.TXLINE_V1, fixtureIdentity: valid.fixtureIdentity, requireFinal: true,
    })).toThrow("oracle_raw_payload_hash_mismatch");
    expect(() => validateOracleReport({ ...valid, finalResult: false }, {
      adapterId: ORACLE_ADAPTERS.TXLINE_V1, fixtureIdentity: valid.fixtureIdentity, requireFinal: true,
    })).toThrow("oracle_final_result_required");
    expect(() => parseTxlineOracleReport({ success: true, data: { fixtureId: "x" } }))
      .toThrow();
  });

  it("qualifies the exact authenticated Sportmonks fixture and rejects mismatches", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { id: 9901 },
      subscription: [{ plans: [{ plan: "Pro - Trialing until 2026-08-06" }] }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifySportmonksFixture("https://api.sportmonks.test/v3/football", "trial-token-value", "9901", "TRIAL"))
      .resolves.toMatchObject({ rawPayloadHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), accessTier: "TRIAL" });
    await expect(verifySportmonksFixture("https://api.sportmonks.test/v3/football", "trial-token-value", "9902", "TRIAL"))
      .rejects.toThrow("oracle_witness_fixture_mismatch");
    const requested = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requested.pathname).toBe("/v3/football/fixtures/9901");
    expect(requested.searchParams.get("api_token")).toBe("trial-token-value");
  });

  it("rejects paid witness credentials and access-tier misrepresentation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { id: 9901 }, subscription: [{ plans: [{ plan: "Pro Annual" }] }],
    }), { status: 200 })));
    await expect(verifySportmonksFixture(
      "https://api.sportmonks.test/v3/football", "paid-token", "9901", "FREE",
    )).rejects.toThrow("oracle_witness_paid_subscription_forbidden");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { id: 9901 }, subscription: [{ plans: [{ plan: "Pro Trialing" }] }],
    }), { status: 200 })));
    await expect(verifySportmonksFixture(
      "https://api.sportmonks.test/v3/football", "trial-token", "9901", "FREE",
    )).rejects.toThrow("oracle_witness_access_tier_mismatch");
  });

  it("parses fragmented TxLINE SSE frames with resume ids", async () => {
    const encoder = new TextEncoder();
    const body = `id: 41\ndata: ${JSON.stringify(txline(41))}\n\nid: 42\ndata: ${JSON.stringify(txline(42))}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, 37)));
        controller.enqueue(encoder.encode(body.slice(37)));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseOracleSse(stream)) events.push(event);
    expect(events.map((event) => event.id)).toEqual(["41", "42"]);
    expect(parseTxlineOracleReport(events[1]!.data).sequence).toBe(42n);
  });

  it("normalizes the real TxLINE score-stream shape instead of a REST envelope", () => {
    const report = parseTxlineScoreSseReport({
      FixtureId: 18_257_865,
      Ts: "2026-07-23T12:00:04.000Z",
      UpdateId: "score:44",
      Status: "second_half",
      Score: {
        Participant1: { Total: { Goals: 2 } },
        Participant2: { Total: { Goals: 1 } },
      },
    }, undefined, "2026-07-23T12:00:05.000Z", "44");
    expect(report).toMatchObject({
      adapterId: ORACLE_ADAPTERS.TXLINE_V1,
      fixtureIdentity: "18257865",
      homeScore: 2,
      awayScore: 1,
      finalResult: false,
      normalizedOutcome: 0,
      proof: { kind: "TXLINE_AUTHENTICATED_SSE", eventId: "44" },
    });
  });

  it("normalizes every row from a batched TxLINE score event", () => {
    const reports = parseTxlineScoreSseReports({ updates: [
      { FixtureId: 1, homeScore: 0, awayScore: 0, timestamp: "2026-07-23T12:00:00.000Z" },
      { FixtureId: 2, homeScore: 1, awayScore: 0, timestamp: "2026-07-23T12:00:01.000Z" },
    ] }, undefined, "2026-07-23T12:00:02.000Z", "batch-1");
    expect(reports.map((report) => report.fixtureIdentity)).toEqual(["1", "2"]);
  });
});
