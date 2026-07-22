import { getAddress, isAddress, isHex, keccak256, stringToHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "./config.js";

const UINT128_MAX = 2n ** 128n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const VERSION_PATTERN = /^[a-z][a-z0-9.-]{1,62}-v[1-9]\d*$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9.-]{1,63}$/;
const FIXTURE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FIELD_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

export const ARC_EXCHANGE_ADDRESS = getAddress("0x1457B0E54f697E9662E1678b74f545CFCe17e96a");
export const ARC_MARKET_ID_HASH_DOMAIN = "air-arena/arc/market-id/v1\0";
export const ARC_MARKET_SPEC_HASH_DOMAIN = "air-arena/arc/market-spec/v1\0";

export class ArcMarketSpecValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "ArcMarketSpecValidationError";
  }
}

function validationError(code: string, path: string, message: string): never {
  throw new ArcMarketSpecValidationError(code, path, message);
}

function isCanonicalUtcSecond(value: string): boolean {
  if (!UTC_SECONDS_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === `${value.slice(0, -1)}.000Z`;
}

function isCanonicalUint(value: string, maximum: bigint): boolean {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false;
  try {
    return BigInt(value) <= maximum;
  } catch {
    return false;
  }
}

const VersionSchema = z.string().regex(VERSION_PATTERN);
const Uint128StringSchema = z.string().refine((value) => isCanonicalUint(value, UINT128_MAX), "must be a canonical unsigned uint128 decimal string");
const PositiveUint128StringSchema = Uint128StringSchema.refine((value) => value !== "0", "must be greater than zero");
const Uint256StringSchema = z.string().refine((value) => isCanonicalUint(value, UINT256_MAX), "must be a canonical unsigned uint256 decimal string");
const UtcTimestampSchema = z.string().refine(isCanonicalUtcSecond, "must be an exact UTC timestamp with second precision");
const AddressSchema = z.string().refine(isAddress, "must be an EVM address").transform((value) => getAddress(value));
const Bytes32Schema = z.string().refine((value) => isHex(value, { strict: true }) && value.length === 66, "must be bytes32");
const StatusTokenSchema = z.string().regex(TOKEN_PATTERN);
const SourceIdSchema = z.string().regex(SOURCE_ID_PATTERN);
const FieldPathSchema = z.string().regex(FIELD_PATH_PATTERN);

export const ArcOutcomeSchema = z.object({
  index: z.number().int().min(0).max(2),
  id: z.string().regex(TOKEN_PATTERN),
  label: z.string().trim().min(1).max(80),
}).strict();

export const ArcInvalidationPolicySchema = z.object({
  version: VersionSchema,
  payoutMethod: z.literal("EQUAL_PER_OUTCOME"),
  rounding: z.literal("FLOOR"),
  remainderDestination: z.literal("PROTOCOL_DUST_VAULT"),
}).strict();

export const ArcFeePolicySchema = z.object({
  version: VersionSchema,
  tradeFeeBps: z.number().int().min(0).max(1_000),
  rounding: z.literal("CEIL"),
  minimumFeeAtoms: Uint128StringSchema,
  collector: z.literal("PROTOCOL_FEE_VAULT"),
}).strict();

export const ArcCapPolicySchema = z.object({
  version: VersionSchema,
  walletCollateralAtoms: PositiveUint128StringSchema,
  walletOpenOrderReserveAtoms: PositiveUint128StringSchema,
  marketCollateralAtoms: PositiveUint128StringSchema,
  treasuryMarketBudgetAtoms: PositiveUint128StringSchema,
  globalCollateralAtoms: PositiveUint128StringSchema,
  maxOrderQuantityAtoms: PositiveUint128StringSchema,
  maxOpenOrdersPerWallet: z.number().int().min(1).max(10_000),
}).strict();

export const ArcBatchPolicySchema = z.object({
  version: VersionSchema,
  intervalMs: z.number().int().min(250).max(60_000),
  cancelCutoffMs: z.number().int().min(0).max(59_999),
  priceScalePpm: z.literal(1_000_000),
  minPricePpm: z.number().int().min(1).max(999_999),
  maxPricePpm: z.number().int().min(1).max(999_999),
  minQuantityAtoms: PositiveUint128StringSchema,
  quantityStepAtoms: PositiveUint128StringSchema,
  maxOrdersPerBatch: z.number().int().min(1).max(100_000),
  allocationMethod: z.literal("PRO_RATA_AT_CLEARING_PRICE_V1"),
  tieBreakMethod: z.literal("ORDER_HASH_ASC_V1"),
}).strict();

export const ArcOraclePolicySchema = z.object({
  version: VersionSchema,
  minimumIndependentSources: z.literal(2),
  maxReportAgeSeconds: z.number().int().min(1).max(3_600),
  maxSourceTimestampSkewSeconds: z.number().int().min(0).max(600),
  minimumArcConfirmations: z.number().int().min(1).max(128),
  onIntegrityFailure: z.literal("HALT"),
}).strict();

export const ArcParameterSetSchema = z.object({
  version: VersionSchema,
  collateralAllowlistVersion: VersionSchema,
  batch: ArcBatchPolicySchema,
  fees: ArcFeePolicySchema,
  caps: ArcCapPolicySchema,
  oracle: ArcOraclePolicySchema,
  referenceData: z.object({
    version: VersionSchema,
    liveOddsExecution: z.literal("NEVER"),
    staleDataAction: z.literal("SUSPEND_MATCHING"),
  }).strict(),
}).strict();

export const ArcResolutionRuleSchema = z.object({
  version: VersionSchema,
  adapter: z.literal("txline.sports-result.v1"),
  fixtureId: z.string().regex(FIXTURE_ID_PATTERN),
  sport: z.literal("football"),
  settlementBasis: z.enum(["REGULATION_TIME", "TO_ADVANCE"]),
  primarySourceId: SourceIdSchema,
  witnessSourceId: SourceIdSchema,
  fieldMapping: z.object({
    fixtureId: FieldPathSchema,
    status: FieldPathSchema,
    homeScore: FieldPathSchema,
    awayScore: FieldPathSchema,
    action: FieldPathSchema,
  }).strict(),
  finalStatuses: z.array(StatusTokenSchema).min(1).max(16),
  finalActions: z.array(StatusTokenSchema).min(1).max(16),
  graceSeconds: z.number().int().min(60).max(86_400),
  onDivergence: z.literal("INVALID"),
  onUnavailable: z.literal("INVALID"),
  correctionPolicy: z.literal("ACCEPT_BEFORE_FINALIZATION_ONLY"),
}).strict();

export const ArcMarketSpecDraftSchema = z.object({
  schemaVersion: z.literal("arc-market-spec-v1"),
  chain: z.object({
    family: z.literal("EVM"),
    network: z.literal("arc-testnet"),
    chainId: z.literal(ARC_CHAIN_ID),
    exchangeAddress: AddressSchema,
    contractVersion: z.literal("arena-exchange-v2"),
  }).strict(),
  marketNonce: Uint256StringSchema,
  category: z.literal("SPORTS"),
  templateId: z.enum(["sports.result.1x2.v1", "sports.result.to-advance.v1"]),
  collateral: z.object({
    tokenAddress: AddressSchema,
    symbol: z.literal("USDC"),
    decimals: z.literal(6),
    payoutAtoms: PositiveUint128StringSchema,
  }).strict(),
  outcomes: z.array(ArcOutcomeSchema).min(2).max(3),
  scheduledStartAt: UtcTimestampSchema,
  tradingOpensAt: UtcTimestampSchema,
  tradingClosesAt: UtcTimestampSchema,
  resolutionEarliestAt: UtcTimestampSchema,
  parameters: ArcParameterSetSchema,
  resolutionRule: ArcResolutionRuleSchema,
  invalidation: ArcInvalidationPolicySchema,
}).strict();

export const FinalizedArcMarketSpecSchema = ArcMarketSpecDraftSchema.extend({
  marketId: Bytes32Schema,
  specHash: Bytes32Schema,
}).strict();

export type ArcOutcome = z.infer<typeof ArcOutcomeSchema>;
export type ArcInvalidationPolicy = z.infer<typeof ArcInvalidationPolicySchema>;
export type ArcFeePolicy = z.infer<typeof ArcFeePolicySchema>;
export type ArcMarketSpecDraft = z.infer<typeof ArcMarketSpecDraftSchema>;
export type FinalizedArcMarketSpec = z.infer<typeof FinalizedArcMarketSpecSchema>;

function parseSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const issuePath = issue?.path.length ? issue.path.join(".") : "$";
  validationError("SCHEMA_INVALID", issuePath, issue?.message ?? "schema validation failed");
}

function assertUnique(values: string[], issuePath: string): void {
  if (new Set(values).size !== values.length) validationError("DUPLICATE_VALUE", issuePath, "values must be unique");
}

function asAtoms(value: string): bigint {
  return BigInt(value);
}

function validateTemplate(spec: ArcMarketSpecDraft): void {
  const outcomeIds = spec.outcomes.map((outcome) => outcome.id).join(",");
  if (spec.templateId === "sports.result.1x2.v1") {
    if (spec.resolutionRule.settlementBasis !== "REGULATION_TIME") {
      validationError("TEMPLATE_MISMATCH", "resolutionRule.settlementBasis", "1X2 requires regulation-time settlement");
    }
    if (outcomeIds !== "home,draw,away") validationError("TEMPLATE_MISMATCH", "outcomes", "1X2 outcomes must be home, draw, away");
    return;
  }
  if (spec.resolutionRule.settlementBasis !== "TO_ADVANCE") {
    validationError("TEMPLATE_MISMATCH", "resolutionRule.settlementBasis", "to-advance requires advancement settlement");
  }
  if (outcomeIds !== "home,away") validationError("TEMPLATE_MISMATCH", "outcomes", "to-advance outcomes must be home, away");
}

function validateSemantics(spec: ArcMarketSpecDraft): void {
  if (spec.chain.exchangeAddress !== ARC_EXCHANGE_ADDRESS) {
    validationError("WRONG_EXCHANGE", "chain.exchangeAddress", "exchange does not match the signed ARC beta scope");
  }
  if (spec.collateral.tokenAddress !== getAddress(ARC_USDC_ADDRESS)) {
    validationError("WRONG_COLLATERAL", "collateral.tokenAddress", "token does not match ARC Testnet USDC");
  }

  assertUnique(spec.outcomes.map((outcome) => outcome.id), "outcomes.id");
  assertUnique(spec.outcomes.map((outcome) => outcome.label.toLowerCase()), "outcomes.label");
  assertUnique(spec.outcomes.map((outcome) => String(outcome.index)), "outcomes.index");
  spec.outcomes.forEach((outcome, index) => {
    if (outcome.index !== index) validationError("OUTCOME_INDEX_GAP", `outcomes.${index}.index`, "indices must be contiguous from zero");
  });
  validateTemplate(spec);

  assertUnique(spec.resolutionRule.finalStatuses, "resolutionRule.finalStatuses");
  assertUnique(spec.resolutionRule.finalActions, "resolutionRule.finalActions");
  const statuses = new Set(spec.resolutionRule.finalStatuses);
  if (spec.resolutionRule.finalActions.some((action) => statuses.has(action))) {
    validationError("AMBIGUOUS_FINALITY", "resolutionRule", "final status and action tokens must not overlap");
  }
  if (spec.resolutionRule.primarySourceId === spec.resolutionRule.witnessSourceId) {
    validationError("SOURCE_NOT_INDEPENDENT", "resolutionRule.witnessSourceId", "primary and witness sources must differ");
  }

  const opensAt = Date.parse(spec.tradingOpensAt);
  const startsAt = Date.parse(spec.scheduledStartAt);
  const closesAt = Date.parse(spec.tradingClosesAt);
  const resolutionAt = Date.parse(spec.resolutionEarliestAt);
  if (!(opensAt < closesAt && closesAt < resolutionAt)) {
    validationError("INVALID_TIME_ORDER", "tradingClosesAt", "expected open < close < resolution");
  }
  if (!(opensAt <= startsAt && startsAt < resolutionAt)) {
    validationError("INVALID_TIME_ORDER", "scheduledStartAt", "scheduled start must fall between open and resolution");
  }

  const batch = spec.parameters.batch;
  if (batch.cancelCutoffMs >= batch.intervalMs) {
    validationError("INVALID_BATCH_POLICY", "parameters.batch.cancelCutoffMs", "cancel cutoff must be smaller than interval");
  }
  if (batch.minPricePpm >= batch.maxPricePpm) {
    validationError("INVALID_BATCH_POLICY", "parameters.batch.minPricePpm", "minimum price must be below maximum price");
  }
  if (asAtoms(batch.minQuantityAtoms) % asAtoms(batch.quantityStepAtoms) !== 0n) {
    validationError("INVALID_BATCH_POLICY", "parameters.batch.minQuantityAtoms", "minimum quantity must be a quantity-step multiple");
  }

  const caps = spec.parameters.caps;
  const walletCollateral = asAtoms(caps.walletCollateralAtoms);
  const walletReserve = asAtoms(caps.walletOpenOrderReserveAtoms);
  const marketCollateral = asAtoms(caps.marketCollateralAtoms);
  const treasuryBudget = asAtoms(caps.treasuryMarketBudgetAtoms);
  const globalCollateral = asAtoms(caps.globalCollateralAtoms);
  const maxOrder = asAtoms(caps.maxOrderQuantityAtoms);
  if (walletReserve > walletCollateral) validationError("INVALID_CAP_POLICY", "parameters.caps.walletOpenOrderReserveAtoms", "reserve exceeds wallet cap");
  if (maxOrder > walletReserve) validationError("INVALID_CAP_POLICY", "parameters.caps.maxOrderQuantityAtoms", "order exceeds reserve cap");
  if (walletCollateral > marketCollateral || treasuryBudget > marketCollateral || marketCollateral > globalCollateral) {
    validationError("INVALID_CAP_POLICY", "parameters.caps", "caps must satisfy wallet and treasury <= market <= global");
  }
  if (asAtoms(batch.minQuantityAtoms) > maxOrder) validationError("INVALID_CAP_POLICY", "parameters.caps.maxOrderQuantityAtoms", "order cap is below minimum quantity");
  if (asAtoms(spec.collateral.payoutAtoms) > walletCollateral) validationError("INVALID_CAP_POLICY", "collateral.payoutAtoms", "payout exceeds wallet cap");

  const minimumFee = asAtoms(spec.parameters.fees.minimumFeeAtoms);
  if (minimumFee > maxOrder) validationError("INVALID_FEE_POLICY", "parameters.fees.minimumFeeAtoms", "minimum fee exceeds order cap");
  if (spec.parameters.fees.tradeFeeBps === 0 && minimumFee !== 0n) {
    validationError("INVALID_FEE_POLICY", "parameters.fees.minimumFeeAtoms", "zero-bps fee requires zero minimum");
  }
}

export function parseArcMarketSpecDraft(input: unknown): ArcMarketSpecDraft {
  const parsed = parseSchema(ArcMarketSpecDraftSchema, input);
  const normalized: ArcMarketSpecDraft = {
    ...parsed,
    outcomes: [...parsed.outcomes].sort((left, right) => left.index - right.index),
    resolutionRule: {
      ...parsed.resolutionRule,
      finalStatuses: [...parsed.resolutionRule.finalStatuses].sort(),
      finalActions: [...parsed.resolutionRule.finalActions].sort(),
    },
  };
  validateSemantics(normalized);
  return normalized;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeArcJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) validationError("NON_CANONICAL_NUMBER", "$", "numbers must be safe integers and not negative zero");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalizeArcJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    if (!isPlainObject(value)) validationError("NON_CANONICAL_OBJECT", "$", "only plain JSON objects are allowed");
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeArcJson(value[key])}`).join(",")}}`;
  }
  validationError("NON_CANONICAL_TYPE", "$", `unsupported JSON type: ${typeof value}`);
}

function domainSeparatedHash(domain: string, canonicalPayload: string): Hex {
  return keccak256(stringToHex(`${domain}${canonicalPayload}`));
}

export function arcMarketIdentity(spec: ArcMarketSpecDraft): Record<string, unknown> {
  return {
    schemaVersion: spec.schemaVersion,
    chainId: spec.chain.chainId,
    exchangeAddress: spec.chain.exchangeAddress,
    collateralTokenAddress: spec.collateral.tokenAddress,
    marketNonce: spec.marketNonce,
    category: spec.category,
    templateId: spec.templateId,
    fixtureId: spec.resolutionRule.fixtureId,
    scheduledStartAt: spec.scheduledStartAt,
    settlementBasis: spec.resolutionRule.settlementBasis,
    parameterVersion: spec.parameters.version,
    outcomes: spec.outcomes.map(({ index, id }) => ({ index, id })),
  };
}

export function canonicalArcMarketIdentity(input: unknown): string {
  return canonicalizeArcJson(arcMarketIdentity(parseArcMarketSpecDraft(input)));
}

export function deriveArcMarketId(input: unknown): Hex {
  return domainSeparatedHash(ARC_MARKET_ID_HASH_DOMAIN, canonicalArcMarketIdentity(input));
}

export function arcMarketSpecPayload(input: unknown): Omit<FinalizedArcMarketSpec, "specHash"> {
  const spec = parseArcMarketSpecDraft(input);
  return { ...spec, marketId: deriveArcMarketId(spec) };
}

export function canonicalArcMarketSpecPayload(input: unknown): string {
  return canonicalizeArcJson(arcMarketSpecPayload(input));
}

export function deriveArcSpecHash(input: unknown): Hex {
  return domainSeparatedHash(ARC_MARKET_SPEC_HASH_DOMAIN, canonicalArcMarketSpecPayload(input));
}

export function finalizeArcMarketSpec(input: unknown): FinalizedArcMarketSpec {
  const payload = arcMarketSpecPayload(input);
  return { ...payload, specHash: domainSeparatedHash(ARC_MARKET_SPEC_HASH_DOMAIN, canonicalizeArcJson(payload)) };
}

export function verifyFinalizedArcMarketSpec(input: unknown): FinalizedArcMarketSpec {
  const parsed = parseSchema(FinalizedArcMarketSpecSchema, input);
  const { marketId, specHash, ...draft } = parsed;
  const expected = finalizeArcMarketSpec(draft);
  if (marketId !== expected.marketId) validationError("MARKET_ID_MISMATCH", "marketId", "market ID does not match canonical identity");
  if (specHash !== expected.specHash) validationError("SPEC_HASH_MISMATCH", "specHash", "spec hash does not match canonical payload");
  return expected;
}

export function arcInvalidationPayout(specInput: unknown): {
  payoutPerOutcomeAtoms: string;
  remainderAtoms: string;
  remainderDestination: ArcInvalidationPolicy["remainderDestination"];
} {
  const spec = parseArcMarketSpecDraft(specInput);
  const outcomes = BigInt(spec.outcomes.length);
  const payout = asAtoms(spec.collateral.payoutAtoms);
  return {
    payoutPerOutcomeAtoms: (payout / outcomes).toString(),
    remainderAtoms: (payout % outcomes).toString(),
    remainderDestination: spec.invalidation.remainderDestination,
  };
}

export function arcTradeFeeAtoms(notionalAtomsInput: unknown, policyInput: unknown): string {
  const notional = parseSchema(PositiveUint128StringSchema, notionalAtomsInput);
  const policy = parseSchema(ArcFeePolicySchema, policyInput);
  const minimum = asAtoms(policy.minimumFeeAtoms);
  if (policy.tradeFeeBps === 0 && minimum !== 0n) validationError("INVALID_FEE_POLICY", "minimumFeeAtoms", "zero-bps fee requires zero minimum");
  const percentage = (asAtoms(notional) * BigInt(policy.tradeFeeBps) + 9_999n) / 10_000n;
  const fee = percentage > minimum ? percentage : minimum;
  if (fee > UINT128_MAX) validationError("FEE_OVERFLOW", "$", "calculated fee exceeds uint128");
  return fee.toString();
}

export type ArcMarketIdentity = ReturnType<typeof arcMarketIdentity>;
export type ArcMarketAddress = Address;
