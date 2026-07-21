import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
  loadDay3Artifacts,
  validateDay3Artifacts,
} from "../scripts/validate-arena-day3.mjs";

let canonical;
let artifacts;

before(async () => {
  canonical = await loadDay3Artifacts();
});

beforeEach(() => {
  artifacts = structuredClone(canonical);
});

function expectFailure(pattern) {
  assert.throws(
    () => validateDay3Artifacts(artifacts, { requireSignoff: true }),
    pattern
  );
}

describe("AIR Arena Day 3 security model", () => {
  it("accepts the signed canonical threat, authority and launch artifacts", () => {
    const result = validateDay3Artifacts(artifacts, { requireSignoff: true });
    assert.deepEqual(result, {
      roles: 14,
      protectedActions: 11,
      threats: 20,
      controls: 24,
      approvalDomains: 6,
      hardBlockers: 13,
    });
  });

  it("rejects wallet private-key ingress", () => {
    artifacts.authority.keyPolicy.rawPrivateKeysAcceptedByApi = true;
    expectFailure(/rawPrivateKeysAcceptedByApi must remain false/);
  });

  it("rejects any role that gains a globally forbidden capability", () => {
    artifacts.authority.roles.find((role) => role.roleId === "market_admin_multisig")
      .permissions.push("accept_wallet_private_key");
    expectFailure(/grants a globally forbidden capability/);
  });

  it("rejects a sequencer that can attest a resolution", () => {
    artifacts.authority.protectedActions.find((action) => action.actionId === "attest_resolution")
      .authorizedRoles = ["batch_sequencer"];
    expectFailure(/attest_resolution.authorizedRoles must equal: resolution_quorum/);
  });

  it("rejects weakening financial separation of duties", () => {
    artifacts.authority.separationOfDuties
      .find((rule) => rule.ruleId === "financial-control-plane-separation")
      .mutuallyExclusiveRoles.pop();
    expectFailure(/financial-control-plane-separation roles/);
  });

  it("rejects missing AIR OTC and AIR Arena product-boundary coverage", () => {
    artifacts.threat.abuseCases = artifacts.threat.abuseCases.filter(
      (threat) => threat.threatId !== "TM-17-PRODUCT-BOUNDARY"
    );
    expectFailure(/abuseCases must contain at least 20 item/);
  });

  it("records the current ARC resolver and service-key paths as critical release blockers", () => {
    const threatIds = new Set(artifacts.threat.abuseCases.map((threat) => threat.threatId));
    const blockerIds = new Set(artifacts.launch.hardBlockers.map((blocker) => blocker.blockerId));
    assert(threatIds.has("TM-19-RESOLVER-CALLER-OUTCOME"));
    assert(threatIds.has("TM-20-ENV-SERVICE-KEYS"));
    assert(blockerIds.has("LG-10-RESOLVER-EVIDENCE-BINDING"));
    assert(blockerIds.has("LG-11-SERVICE-KEY-CUSTODY"));
    assert(blockerIds.has("LG-12-PAUSER-RESUME"));
    assert(blockerIds.has("LG-13-ADMIN-TIMELOCK"));
  });

  it("requires code evidence for verified current ARC blockers", () => {
    delete artifacts.threat.abuseCases
      .find((threat) => threat.threatId === "TM-19-RESOLVER-CALLER-OUTCOME")
      .codeEvidence;
    expectFailure(/TM-19-RESOLVER-CALLER-OUTCOME.codeEvidence/);
  });

  it("fails if the verified resolver code boundary changes without a threat-model update", () => {
    artifacts.arcContract = artifacts.arcContract.replace(
      "function resolveMarket(bytes32 marketId, uint8 winningOutcome) external onlyRole(RESOLVER_ROLE)",
      "function resolveMarket(bytes32 marketId, uint8 winningOutcome) external"
    );
    expectFailure(/current ARC contract evidence changed/);
  });

  it("fails if an environment-backed role key disappears without a custody-model update", () => {
    artifacts.arcConfig = artifacts.arcConfig.replaceAll("ARC_RESOLVER_PRIVATE_KEY", "REMOVED_RESOLVER_KEY");
    expectFailure(/current ARC key-custody evidence changed/);
  });

  it("requires complete STRIDE coverage", () => {
    for (const threat of artifacts.threat.abuseCases) {
      threat.stride = threat.stride.map((category) => category === "I" ? "T" : category);
    }
    expectFailure(/STRIDE coverage/);
  });

  it("rejects an unknown control reference", () => {
    artifacts.threat.abuseCases[0].controlIds[0] = "CTRL-NOT-DEFINED";
    expectFailure(/references unknown control CTRL-NOT-DEFINED/);
  });

  it("rejects an unacceptably high residual risk", () => {
    artifacts.threat.abuseCases[0].residualRisk = "critical";
    expectFailure(/leaves an unacceptable residual risk/);
  });

  it("keeps public mainnet and real-value public access disabled", () => {
    artifacts.launch.publicMainnetAllowed = true;
    expectFailure(/publicMainnetAllowed must remain false/);
  });

  it("rejects legal self-approval without external evidence", () => {
    artifacts.launch.requiredApprovalDomains.find((domain) => domain.domainId === "legal")
      .status = "approved";
    expectFailure(/legal cannot be approved without external evidence/);
  });

  it("rejects an emergency launch bypass", () => {
    artifacts.launch.emergencyOverrideAllowed = true;
    expectFailure(/emergencyOverrideAllowed must remain false/);
  });

  it("rejects a closed blocker without immutable evidence", () => {
    artifacts.launch.hardBlockers[0].state = "closed";
    expectFailure(/cannot close before its immutable evidence exists/);
  });

  it("requires documents to stay bound to canonical machine-readable artifacts", () => {
    artifacts.launchDocument = artifacts.launchDocument.replace(
      "config/arena-exchange/launch-gate.v1.json",
      "config/arena-exchange/other-gate.json"
    );
    expectFailure(/launchDocument is missing binding marker/);
  });
});
