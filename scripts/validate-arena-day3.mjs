#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireSignoff = process.argv.includes("--require-signoff");

export const DAY3_PATHS = Object.freeze({
  authority: "config/arena-exchange/authority-matrix.v1.json",
  threat: "config/arena-exchange/threat-model.v1.json",
  launch: "config/arena-exchange/launch-gate.v1.json",
  threatDocument: "docs/security/ARENA_EXCHANGE_THREAT_MODEL_V1.md",
  authorityDocument: "docs/security/ARENA_EXCHANGE_AUTHORITY_MATRIX_V1.md",
  launchDocument: "docs/compliance/ARENA_EXCHANGE_LAUNCH_GATE_V1.md",
  arcContract: "arc-stack/contracts/src/ArenaExchange.sol",
  arcConfig: "arc-stack/src/config.ts",
  arcMiddleman: "arc-stack/src/middleman.ts",
});

const REQUIRED_ROLES = [
  "agent_wallet",
  "market_admin_multisig",
  "batch_sequencer",
  "resolution_quorum",
  "oracle_adapter",
  "protocol_liquidity_agent",
  "emergency_pauser",
  "recovery_multisig",
  "contract_admin_multisig",
  "treasury_multisig",
  "reconciler",
  "legal_compliance_owner",
  "security_release_owner",
  "deployment_executor",
];

const REQUIRED_ACTIONS = Object.freeze({
  create_market_draft: { roles: ["market_admin_multisig"], quorum: 2, timelock: 0 },
  validate_market: { roles: ["market_admin_multisig"], quorum: 2, timelock: 0 },
  propose_batch: { roles: ["batch_sequencer"], quorum: 1, timelock: 0 },
  attest_resolution: { roles: ["resolution_quorum"], quorum: 2, timelock: 0 },
  pause_market: { roles: ["emergency_pauser"], quorum: 1, timelock: 0 },
  resume_market: { roles: ["recovery_multisig"], quorum: 2, timelock: 0 },
  manage_contract_roles: { roles: ["contract_admin_multisig"], quorum: 3, timelock: 172800 },
  fund_protocol_liquidity: { roles: ["treasury_multisig"], quorum: 2, timelock: 0 },
  withdraw_protocol_capital: { roles: ["treasury_multisig"], quorum: 2, timelock: 86400 },
  withdraw_user_collateral: { roles: ["agent_wallet"], quorum: 1, timelock: 0 },
  deploy_public_mainnet: { roles: ["deployment_executor"], quorum: 1, timelock: 0 },
});

const REQUIRED_GLOBAL_PROHIBITIONS = [
  "accept_wallet_private_key",
  "bypass_launch_gate",
  "choose_winner_discretionarily",
  "edit_open_market_spec",
  "move_another_wallet_collateral",
  "redirect_settlement_payout",
  "reuse_air_otc_financial_authority",
];

const REQUIRED_APPROVAL_DOMAINS = [
  "legal",
  "privacy-data-protection",
  "security",
  "protocol-custody",
  "operations",
  "release-artifact",
];

const REQUIRED_TRUST_ASSUMPTIONS = [
  "TA-01-ARC",
  "TA-02-COLLATERAL",
  "TA-03-ORACLES",
  "TA-04-SEQUENCER",
  "TA-05-KEY-CUSTODY",
  "TA-06-DURABILITY",
  "TA-07-PRODUCT-ISOLATION",
  "TA-08-LEGAL",
];

const REQUIRED_THREATS = [
  "TM-01-WALLET-SPOOF",
  "TM-02-MARKET-TAMPER",
  "TM-03-SEQUENCER-ABUSE",
  "TM-04-BATCH-TAMPER",
  "TM-05-RESERVATION-RACE",
  "TM-06-RESOLVER-CAPTURE",
  "TM-07-ORACLE-INTEGRITY",
  "TM-08-PAUSER-ABUSE",
  "TM-09-UPGRADE-COMPROMISE",
  "TM-10-LIQUIDITY-VAULT",
  "TM-11-KEY-EXFILTRATION",
  "TM-12-DATA-DISCLOSURE",
  "TM-13-DENIAL-OF-SERVICE",
  "TM-14-LOST-ACK",
  "TM-15-SUPPLY-CHAIN",
  "TM-16-RPC-REORG",
  "TM-17-PRODUCT-BOUNDARY",
  "TM-18-LAUNCH-BYPASS",
  "TM-19-RESOLVER-CALLER-OUTCOME",
  "TM-20-ENV-SERVICE-KEYS",
];

const REQUIRED_HARD_BLOCKERS = [
  "LG-01-JURISDICTION",
  "LG-02-PRIVACY",
  "LG-03-INDEPENDENT-AUDIT",
  "LG-04-CUSTODY-PROOF",
  "LG-05-FAIR-ORDERING",
  "LG-06-KEY-CUSTODY",
  "LG-07-LIVE-EVIDENCE",
  "LG-08-RELEASE-PROVENANCE",
  "LG-09-PRODUCT-ISOLATION",
  "LG-10-RESOLVER-EVIDENCE-BINDING",
  "LG-11-SERVICE-KEY-CUSTODY",
  "LG-12-PAUSER-RESUME",
  "LG-13-ADMIN-TIMELOCK",
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function requireArray(value, label, minimum = 1) {
  invariant(Array.isArray(value), `${label} must be an array`);
  invariant(value.length >= minimum, `${label} must contain at least ${minimum} item(s)`);
  return value;
}

function uniqueBy(items, key, label) {
  const ids = items.map((item) => item?.[key]);
  invariant(ids.every(nonEmptyString), `${label} entries require ${key}`);
  invariant(new Set(ids).size === ids.length, `${label} contains duplicate ${key}`);
  return new Map(items.map((item) => [item[key], item]));
}

function requireExactSet(actual, expected, label) {
  requireArray(actual, label, expected.length);
  invariant(new Set(actual).size === actual.length, `${label} contains duplicates`);
  invariant(
    actual.length === expected.length && expected.every((value) => actual.includes(value)),
    `${label} must equal: ${expected.join(", ")}`
  );
}

function requireIncludes(actual, expected, label) {
  requireArray(actual, label);
  for (const value of expected) {
    invariant(actual.includes(value), `${label} is missing ${value}`);
  }
}

function validateTechnicalApproval(approval, label, signoffRequired) {
  invariant(isObject(approval), `${label} is required`);
  invariant(["pending", "approved"].includes(approval.status), `${label}.status is invalid`);
  if (signoffRequired) invariant(approval.status === "approved", `${label} is not approved`);
  if (approval.status === "approved") {
    invariant(nonEmptyString(approval.approvedBy), `${label}.approvedBy is required`);
    invariant(isIsoTimestamp(approval.approvedAt), `${label}.approvedAt must be an ISO timestamp`);
    invariant(nonEmptyString(approval.approvalReference), `${label}.approvalReference is required`);
  }
}

function validateAuthorityMatrix(authority, signoffRequired) {
  invariant(authority.schemaVersion === 1, "authority schemaVersion must be 1");
  invariant(authority.modelId === "air-arena-arc-authority-matrix-v1", "unexpected authority modelId");
  invariant(authority.status === "approved", "authority matrix must be approved");
  invariant(authority.scopeManifest === "config/arena-exchange/beta-scope.v1.json", "authority scope manifest changed");
  invariant(authority.network?.name === "arc-testnet" && authority.network?.chainId === 5_042_002, "authority network must be ARC Testnet 5042002");
  invariant(authority.exchangeContract === "ArenaExchange", "authority contract must be ArenaExchange");
  invariant(authority.exchangeAddress === "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071", "authority exchange address changed");
  invariant(authority.apiService === "airarena-arc-api" && authority.apiNamespace === "/v1", "authority API boundary changed");
  invariant(authority.mcpService === "airarena-arc-mcp" && authority.mcpToolPrefix === "airarena_arc_", "authority MCP boundary changed");
  invariant(authority.databaseNamespace === "arc_", "authority database namespace must be arc_");
  invariant(authority.defaultDeny === true, "authority matrix must be default deny");

  const keyPolicy = authority.keyPolicy;
  invariant(isObject(keyPolicy), "keyPolicy is required");
  for (const falsePolicy of [
    "rawPrivateKeysAcceptedByApi",
    "rawPrivateKeysPersisted",
    "productionSecretsInEnvironmentFiles",
    "sharedKeysAcrossAirOtcAndAirArena",
  ]) {
    invariant(keyPolicy[falsePolicy] === false, `${falsePolicy} must remain false`);
  }
  for (const truePolicy of [
    "privilegedHumanKeysRequireHardwareBacking",
    "serviceKeysRequireManagedKms",
    "quarterlyMembershipReviewRequired",
    "emergencyRotationRunbookRequired",
    "serviceKeysCurrentlyEnvironmentBacked",
    "serviceKeysMustMigrateToManagedKmsBeforePublicLaunch",
  ]) {
    invariant(keyPolicy[truePolicy] === true, `${truePolicy} must remain true`);
  }

  requireExactSet(
    authority.globallyForbiddenCapabilities,
    REQUIRED_GLOBAL_PROHIBITIONS,
    "globallyForbiddenCapabilities"
  );

  const roleMap = uniqueBy(requireArray(authority.roles, "roles", REQUIRED_ROLES.length), "roleId", "roles");
  for (const roleId of REQUIRED_ROLES) invariant(roleMap.has(roleId), `missing required role: ${roleId}`);
  invariant(roleMap.size === REQUIRED_ROLES.length, "unexpected authority role added without a schema version change");

  for (const role of roleMap.values()) {
    invariant(nonEmptyString(role.principalType), `${role.roleId}.principalType is required`);
    invariant(nonEmptyString(role.keyCustody), `${role.roleId}.keyCustody is required`);
    requireArray(role.permissions, `${role.roleId}.permissions`);
    requireArray(role.prohibitions, `${role.roleId}.prohibitions`);
    invariant(new Set(role.permissions).size === role.permissions.length, `${role.roleId}.permissions contains duplicates`);
    invariant(new Set(role.prohibitions).size === role.prohibitions.length, `${role.roleId}.prohibitions contains duplicates`);
    invariant(
      role.permissions.every((permission) => !role.prohibitions.includes(permission)),
      `${role.roleId} both permits and prohibits the same capability`
    );
    invariant(
      role.permissions.every((permission) => !authority.globallyForbiddenCapabilities.includes(permission)),
      `${role.roleId} grants a globally forbidden capability`
    );
  }

  requireIncludes(roleMap.get("agent_wallet").prohibitions, ["move_another_wallet_collateral", "publish_resolution"], "agent_wallet.prohibitions");
  requireIncludes(roleMap.get("batch_sequencer").prohibitions, ["publish_resolution", "move_user_collateral"], "batch_sequencer.prohibitions");
  requireIncludes(roleMap.get("resolution_quorum").prohibitions, ["choose_winner_discretionarily", "redirect_settlement_payout", "propose_batch"], "resolution_quorum.prohibitions");
  requireIncludes(roleMap.get("emergency_pauser").prohibitions, ["resume_market", "publish_resolution", "move_user_collateral", "manage_contract_roles"], "emergency_pauser.prohibitions");
  requireIncludes(roleMap.get("deployment_executor").prohibitions, ["approve_own_release", "bypass_launch_gate"], "deployment_executor.prohibitions");

  const actionMap = uniqueBy(requireArray(authority.protectedActions, "protectedActions"), "actionId", "protectedActions");
  invariant(actionMap.size === Object.keys(REQUIRED_ACTIONS).length, "protected action set changed without a schema version change");
  for (const [actionId, expected] of Object.entries(REQUIRED_ACTIONS)) {
    const action = actionMap.get(actionId);
    invariant(action, `missing protected action: ${actionId}`);
    requireExactSet(action.authorizedRoles, expected.roles, `${actionId}.authorizedRoles`);
    invariant(action.minimumQuorum === expected.quorum, `${actionId}.minimumQuorum must be ${expected.quorum}`);
    invariant(action.timelockSeconds === expected.timelock, `${actionId}.timelockSeconds must be ${expected.timelock}`);
    requireArray(action.requiredConditions, `${actionId}.requiredConditions`, 2);
    for (const roleId of action.authorizedRoles) invariant(roleMap.has(roleId), `${actionId} references unknown role ${roleId}`);
  }
  requireIncludes(actionMap.get("attest_resolution").requiredConditions, ["outcome_derived_from_immutable_rule"], "attest_resolution.requiredConditions");
  requireIncludes(actionMap.get("withdraw_user_collateral").requiredConditions, ["destination_owned_by_wallet", "withdrawal_nonce_unused"], "withdraw_user_collateral.requiredConditions");
  requireIncludes(actionMap.get("deploy_public_mainnet").requiredConditions, ["launch_gate_approved", "legal_compliance_owner_approved", "security_release_owner_approved", "operations_readiness_approved"], "deploy_public_mainnet.requiredConditions");

  const sodMap = uniqueBy(requireArray(authority.separationOfDuties, "separationOfDuties", 5), "ruleId", "separationOfDuties");
  const financialRoles = ["batch_sequencer", "resolution_quorum", "emergency_pauser", "contract_admin_multisig", "treasury_multisig"];
  requireExactSet(
    sodMap.get("financial-control-plane-separation")?.mutuallyExclusiveRoles,
    financialRoles,
    "financial-control-plane-separation roles"
  );
  requireExactSet(
    sodMap.get("release-approval-separation")?.mutuallyExclusiveRoles,
    ["legal_compliance_owner", "security_release_owner", "deployment_executor", "contract_admin_multisig"],
    "release-approval-separation roles"
  );
  requireExactSet(
    sodMap.get("pause-recovery-separation")?.mutuallyExclusiveRoles,
    ["emergency_pauser", "recovery_multisig"],
    "pause-recovery-separation roles"
  );
  requireExactSet(
    sodMap.get("product-authority-isolation")?.mutuallyExclusiveRoles,
    ["air_otc_financial_authority", "air_arena_financial_authority"],
    "product-authority-isolation roles"
  );
  for (const rule of sodMap.values()) invariant(nonEmptyString(rule.enforcement), `${rule.ruleId}.enforcement is required`);

  validateTechnicalApproval(authority.approval, "authority approval", signoffRequired);
  return { roleMap, actionMap };
}

function validateThreatModel(threat, roleMap, signoffRequired) {
  invariant(threat.schemaVersion === 1, "threat schemaVersion must be 1");
  invariant(threat.modelId === "air-arena-arc-exchange-threat-model-v1", "unexpected threat modelId");
  invariant(threat.status === "approved", "threat model must be approved");
  requireExactSet(threat.methodology, ["STRIDE", "asset-centric", "abuse-case-analysis"], "threat methodology");
  invariant(threat.scopeManifest === "config/arena-exchange/beta-scope.v1.json", "threat scope manifest changed");
  invariant(threat.authorityMatrix === DAY3_PATHS.authority, "threat model is not bound to authority matrix");
  requireArray(threat.systemBoundary?.included, "systemBoundary.included", 8);
  requireArray(threat.systemBoundary?.excluded, "systemBoundary.excluded", 4);
  invariant(threat.systemBoundary.included.some((entry) => entry.includes("ArenaExchange")), "system boundary must include ArenaExchange");
  invariant(!JSON.stringify(threat).includes("Solana"), "ARC threat model contains a Solana implementation assumption");
  invariant(
    threat.systemBoundary.excluded.some((entry) => entry.includes("AIR OTC")),
    "system boundary must exclude AIR OTC financial state"
  );

  const assetMap = uniqueBy(requireArray(threat.assets, "assets", 10), "assetId", "assets");
  for (const asset of assetMap.values()) {
    invariant(nonEmptyString(asset.classification), `${asset.assetId}.classification is required`);
    requireArray(asset.securityObjectives, `${asset.assetId}.securityObjectives`, 2);
  }

  const boundaryMap = uniqueBy(requireArray(threat.trustBoundaries, "trustBoundaries", 9), "boundaryId", "trustBoundaries");
  const controlMap = uniqueBy(requireArray(threat.controls, "controls", 20), "controlId", "controls");
  for (const control of controlMap.values()) {
    invariant(["preventive", "detective", "corrective"].includes(control.type), `${control.controlId}.type is invalid`);
    invariant(roleMap.has(control.ownerRole), `${control.controlId} references unknown owner role ${control.ownerRole}`);
    invariant(["implemented", "partially-implemented", "design-frozen", "planned"].includes(control.status), `${control.controlId}.status is invalid`);
    invariant(Number.isInteger(control.roadmapDay) && control.roadmapDay >= 1 && control.roadmapDay <= 30, `${control.controlId}.roadmapDay is invalid`);
    invariant(nonEmptyString(control.evidenceRequired), `${control.controlId}.evidenceRequired is required`);
  }
  for (const boundary of boundaryMap.values()) {
    invariant(nonEmptyString(boundary.source) && nonEmptyString(boundary.target), `${boundary.boundaryId} endpoints are required`);
    requireArray(boundary.data, `${boundary.boundaryId}.data`);
    requireArray(boundary.requiredControls, `${boundary.boundaryId}.requiredControls`, 2);
    for (const controlId of boundary.requiredControls) invariant(controlMap.has(controlId), `${boundary.boundaryId} references unknown control ${controlId}`);
    invariant(nonEmptyString(boundary.failClosedBehavior), `${boundary.boundaryId}.failClosedBehavior is required`);
  }

  const assumptionMap = uniqueBy(requireArray(threat.trustAssumptions, "trustAssumptions", REQUIRED_TRUST_ASSUMPTIONS.length), "assumptionId", "trustAssumptions");
  requireExactSet([...assumptionMap.keys()], REQUIRED_TRUST_ASSUMPTIONS, "trust assumption IDs");
  for (const assumption of assumptionMap.values()) {
    for (const field of ["statement", "validation", "failureBehavior", "mainnetGate"]) {
      invariant(nonEmptyString(assumption[field]), `${assumption.assumptionId}.${field} is required`);
    }
  }

  const threatMap = uniqueBy(requireArray(threat.abuseCases, "abuseCases", REQUIRED_THREATS.length), "threatId", "abuseCases");
  requireExactSet([...threatMap.keys()], REQUIRED_THREATS, "threat IDs");
  const strideCoverage = new Set();
  for (const abuse of threatMap.values()) {
    requireArray(abuse.stride, `${abuse.threatId}.stride`);
    for (const category of abuse.stride) {
      invariant(["S", "T", "R", "I", "D", "E"].includes(category), `${abuse.threatId} has invalid STRIDE category ${category}`);
      strideCoverage.add(category);
    }
    requireArray(abuse.boundaryIds, `${abuse.threatId}.boundaryIds`);
    for (const boundaryId of abuse.boundaryIds) invariant(boundaryMap.has(boundaryId), `${abuse.threatId} references unknown boundary ${boundaryId}`);
    requireArray(abuse.assetIds, `${abuse.threatId}.assetIds`);
    for (const assetId of abuse.assetIds) invariant(assetMap.has(assetId), `${abuse.threatId} references unknown asset ${assetId}`);
    invariant(["critical", "high", "medium", "low"].includes(abuse.inherentRisk), `${abuse.threatId}.inherentRisk is invalid`);
    invariant(["medium", "low"].includes(abuse.residualRisk), `${abuse.threatId} leaves an unacceptable residual risk`);
    requireArray(abuse.controlIds, `${abuse.threatId}.controlIds`, ["critical", "high"].includes(abuse.inherentRisk) ? 3 : 2);
    for (const controlId of abuse.controlIds) invariant(controlMap.has(controlId), `${abuse.threatId} references unknown control ${controlId}`);
    invariant(abuse.controlIds.some((id) => controlMap.get(id).type === "preventive"), `${abuse.threatId} requires a preventive control`);
    for (const field of ["title", "attacker", "attackPath", "impact", "detection", "response"]) {
      invariant(nonEmptyString(abuse[field]), `${abuse.threatId}.${field} is required`);
    }
    requireArray(abuse.verification, `${abuse.threatId}.verification`);
    invariant(["release-blocker", "explicit-beta-trust-boundary", "mitigated"].includes(abuse.disposition), `${abuse.threatId}.disposition is invalid`);
  }
  requireExactSet([...strideCoverage], ["S", "T", "R", "I", "D", "E"], "STRIDE coverage");
  invariant(threatMap.get("TM-03-SEQUENCER-ABUSE").disposition === "explicit-beta-trust-boundary", "plaintext sequencer trust boundary must be explicit");
  invariant(threatMap.get("TM-17-PRODUCT-BOUNDARY").controlIds.includes("CTRL-PRODUCT-ISOLATION"), "AIR OTC/AIR Arena boundary control is missing");
  invariant(threatMap.get("TM-18-LAUNCH-BYPASS").controlIds.includes("CTRL-LAUNCH-GATE"), "launch bypass is not tied to launch gate");
  for (const threatId of ["TM-19-RESOLVER-CALLER-OUTCOME", "TM-20-ENV-SERVICE-KEYS"]) {
    requireArray(threatMap.get(threatId).codeEvidence, `${threatId}.codeEvidence`, 4);
  }

  validateTechnicalApproval(threat.approval, "threat-model approval", signoffRequired);
  return { threatMap, controlMap };
}

function validateLaunchGate(launch, roleMap, signoffRequired) {
  invariant(launch.schemaVersion === 1, "launch schemaVersion must be 1");
  invariant(launch.gateId === "air-arena-arc-public-mainnet-launch-v1", "unexpected launch gateId");
  invariant(launch.status === "blocked-pending-independent-approvals", "launch gate must remain blocked pending approvals");
  invariant(launch.scopeManifest === "config/arena-exchange/beta-scope.v1.json", "launch scope manifest changed");
  invariant(launch.threatModel === DAY3_PATHS.threat, "launch gate is not bound to threat model");
  invariant(launch.authorityMatrix === DAY3_PATHS.authority, "launch gate is not bound to authority matrix");
  invariant(launch.currentReleaseClass === "capped-arc-testnet-beta-only", "release class must remain capped ARC Testnet beta only");
  for (const field of ["publicMainnetAllowed", "realValuePublicAccessAllowed", "emergencyOverrideAllowed", "selfApprovalAllowed"]) {
    invariant(launch[field] === false, `${field} must remain false`);
  }
  invariant(launch.automaticFailClosed === true, "launch gate must fail closed");
  invariant(launch.notLegalAdvice === true, "launch checkpoint must state that it is not legal advice");

  const beta = launch.betaConstraints;
  invariant(beta?.network === "arc-testnet" && beta?.chainId === 5_042_002, "beta network must remain ARC Testnet 5042002");
  invariant(beta?.exchangeAddress === "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071", "beta exchange address changed");
  invariant(beta?.collateralAddress === "0x3600000000000000000000000000000000000000" && beta?.collateralDecimals === 6, "beta collateral must remain ARC Testnet USDC");
  for (const field of ["allowlistRequired", "depositCapsRequired", "singleStableErc20"]) invariant(beta[field] === true, `${field} must remain true`);
  for (const field of ["realWorldValueRequired", "subjectiveMarketsAllowed", "leverageAllowed", "serverHeldAgentKeysAllowed", "publicMarketingAsMainnetProductionAllowed"]) invariant(beta[field] === false, `${field} must remain false`);

  const approvalMap = uniqueBy(requireArray(launch.requiredApprovalDomains, "requiredApprovalDomains", REQUIRED_APPROVAL_DOMAINS.length), "domainId", "requiredApprovalDomains");
  requireExactSet([...approvalMap.keys()], REQUIRED_APPROVAL_DOMAINS, "launch approval domains");
  for (const approval of approvalMap.values()) {
    invariant(roleMap.has(approval.ownerRole), `${approval.domainId} references unknown owner role ${approval.ownerRole}`);
    invariant(approval.status === "pending", `${approval.domainId} cannot be approved without external evidence`);
    requireArray(approval.mustBeIndependentOf, `${approval.domainId}.mustBeIndependentOf`);
    invariant(!approval.mustBeIndependentOf.includes(approval.ownerRole), `${approval.domainId} independence list cannot contain its own owner`);
    requireArray(approval.evidenceRequired, `${approval.domainId}.evidenceRequired`, 4);
  }

  const blockerMap = uniqueBy(requireArray(launch.hardBlockers, "hardBlockers", REQUIRED_HARD_BLOCKERS.length), "blockerId", "hardBlockers");
  requireExactSet([...blockerMap.keys()], REQUIRED_HARD_BLOCKERS, "hard blocker IDs");
  for (const blocker of blockerMap.values()) {
    invariant(approvalMap.has(blocker.ownerDomain), `${blocker.blockerId} references unknown approval domain`);
    invariant(["open", "resolved"].includes(blocker.state), `${blocker.blockerId} cannot close before its immutable evidence exists`);
    invariant(nonEmptyString(blocker.description), `${blocker.blockerId}.description is required`);
    if (blocker.state === "resolved") requireArray(blocker.codeEvidence, `${blocker.blockerId}.codeEvidence`, 2);
  }
  for (const blockerId of [
    "LG-10-RESOLVER-EVIDENCE-BINDING",
    "LG-11-SERVICE-KEY-CUSTODY",
    "LG-12-PAUSER-RESUME",
    "LG-13-ADMIN-TIMELOCK",
  ]) {
    requireArray(blockerMap.get(blockerId).codeEvidence, `${blockerId}.codeEvidence`, 2);
  }

  const releaseRule = launch.releaseRule;
  for (const field of [
    "allApprovalDomainsMustBeApproved",
    "allEvidenceItemsMustReferenceImmutableArtifacts",
    "allHardBlockersMustBeClosed",
    "independentSmartContractAuditRequired",
    "signedGoNoGoRequired",
    "approvedArtifactDigestRequired",
    "legalScopeMustMatchDeployedScopeExactly",
    "deployedBytecodeMustMatchAuditedArtifact",
  ]) invariant(releaseRule?.[field] === true, `${field} must remain true`);
  for (const field of ["unresolvedP0OrP1Allowed", "configurationCanWeakenGate"]) invariant(releaseRule?.[field] === false, `${field} must remain false`);
  requireArray(launch.requiredUserDisclosures, "requiredUserDisclosures", 6);
  validateTechnicalApproval(launch.technicalApproval, "launch-gate technical approval", signoffRequired);
  invariant(
    launch.technicalApproval.meaning === "The fail-closed launch checkpoint design is approved; no legal or public-mainnet approval is granted.",
    "technical approval must not imply legal or mainnet approval"
  );
}

function validateCurrentArcCodeEvidence(artifacts) {
  const contract = artifacts.arcContract;
  const config = artifacts.arcConfig;
  const middleman = artifacts.arcMiddleman;
  invariant(nonEmptyString(contract), "ARC contract evidence is missing");
  invariant(nonEmptyString(config), "ARC config evidence is missing");
  invariant(nonEmptyString(middleman), "ARC middleman evidence is missing");

  for (const marker of [
    "IArenaResolutionVerifier.ResolutionReport calldata primary",
    "IArenaResolutionVerifier.ResolutionReport calldata witness",
    "function pause() external onlyRole(EMERGENCY_PAUSER_ROLE)",
    "function unpause() external onlyRole(UPGRADE_MULTISIG_ROLE)",
    "function setFeeBps(uint16 newFeeBps) external onlyRole(UPGRADE_MULTISIG_ROLE)",
  ]) {
    invariant(contract.includes(marker), `current ARC contract evidence changed: ${marker}`);
  }
  for (const marker of [
    "ARC_RELAYER_PRIVATE_KEY",
    "ARC_MARKET_ADMIN_PRIVATE_KEY",
    "ARC_MATCHER_PRIVATE_KEY",
    "ARC_RESOLVER_PRIVATE_KEY",
  ]) {
    invariant(config.includes(marker), `current ARC key-custody evidence changed: ${marker}`);
  }
  invariant(middleman.includes('functionName: "resolveMarket"'), "current ARC resolver call evidence changed");
}

function validateDocuments(artifacts) {
  const bindings = [
    ["threatDocument", [DAY3_PATHS.threat, DAY3_PATHS.authority, DAY3_PATHS.launch, "Status: APPROVED"]],
    ["authorityDocument", [DAY3_PATHS.authority, DAY3_PATHS.threat, DAY3_PATHS.launch, "Status: APPROVED"]],
    ["launchDocument", [DAY3_PATHS.launch, DAY3_PATHS.threat, DAY3_PATHS.authority, "Status: BLOCKED", "not legal advice"]],
  ];
  for (const [documentKey, markers] of bindings) {
    const text = artifacts[documentKey];
    invariant(nonEmptyString(text), `${documentKey} is missing`);
    for (const marker of markers) {
      invariant(text.toLowerCase().includes(marker.toLowerCase()), `${documentKey} is missing binding marker: ${marker}`);
    }
  }
}

export function validateDay3Artifacts(artifacts, options = {}) {
  invariant(isObject(artifacts), "Day 3 artifacts are required");
  const authorityResult = validateAuthorityMatrix(artifacts.authority, options.requireSignoff === true);
  const threatResult = validateThreatModel(artifacts.threat, authorityResult.roleMap, options.requireSignoff === true);
  validateLaunchGate(artifacts.launch, authorityResult.roleMap, options.requireSignoff === true);
  validateDocuments(artifacts);
  validateCurrentArcCodeEvidence(artifacts);
  return {
    roles: authorityResult.roleMap.size,
    protectedActions: authorityResult.actionMap.size,
    threats: threatResult.threatMap.size,
    controls: threatResult.controlMap.size,
    approvalDomains: artifacts.launch.requiredApprovalDomains.length,
    hardBlockers: artifacts.launch.hardBlockers.length,
  };
}

async function readRepoFile(relativePath) {
  const absolutePath = path.resolve(rootDir, relativePath);
  invariant(absolutePath.startsWith(`${rootDir}${path.sep}`), `artifact escapes repository: ${relativePath}`);
  return readFile(absolutePath, "utf8");
}

export async function loadDay3Artifacts() {
  const [authorityText, threatText, launchText, threatDocument, authorityDocument, launchDocument, arcContract, arcConfig, arcMiddleman] = await Promise.all([
    readRepoFile(DAY3_PATHS.authority),
    readRepoFile(DAY3_PATHS.threat),
    readRepoFile(DAY3_PATHS.launch),
    readRepoFile(DAY3_PATHS.threatDocument),
    readRepoFile(DAY3_PATHS.authorityDocument),
    readRepoFile(DAY3_PATHS.launchDocument),
    readRepoFile(DAY3_PATHS.arcContract),
    readRepoFile(DAY3_PATHS.arcConfig),
    readRepoFile(DAY3_PATHS.arcMiddleman),
  ]);
  return {
    authority: JSON.parse(authorityText),
    threat: JSON.parse(threatText),
    launch: JSON.parse(launchText),
    threatDocument,
    authorityDocument,
    launchDocument,
    arcContract,
    arcConfig,
    arcMiddleman,
    hashes: {
      authority: `sha256:${createHash("sha256").update(authorityText).digest("hex")}`,
      threat: `sha256:${createHash("sha256").update(threatText).digest("hex")}`,
      launch: `sha256:${createHash("sha256").update(launchText).digest("hex")}`,
    },
  };
}

async function main() {
  const artifacts = await loadDay3Artifacts();
  const result = validateDay3Artifacts(artifacts, { requireSignoff });
  console.log(
    `AIR Arena Day 3 ${requireSignoff ? "exit gate" : "security-model check"}: PASS ` +
      `(${result.threats} threats, ${result.controls} controls, ${result.roles} roles, ` +
      `${result.protectedActions} protected actions, ${result.approvalDomains} independent approval domains)`
  );
  console.log(`authority ${artifacts.hashes.authority}`);
  console.log(`threat    ${artifacts.hashes.threat}`);
  console.log(`launch    ${artifacts.hashes.launch}`);
  console.log(`public mainnet: BLOCKED (${result.hardBlockers} hard blockers fail closed)`);
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`AIR Arena Day 3 validation: FAIL - ${error.message}`);
    process.exitCode = 1;
  });
}
