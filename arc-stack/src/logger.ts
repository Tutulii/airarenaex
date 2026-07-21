import pino from "pino";
import type { ArcConfig } from "./config.js";

const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.x-api-key",
  "config.relayerPrivateKey",
  "config.marketAdminPrivateKey",
  "config.matcherPrivateKey",
  "config.resolverPrivateKey",
  "config.operatorToken",
  "config.authTokenPepper",
  "*.signature",
  "*.privateKey",
];

export function createLogger(config: Pick<ArcConfig, "logLevel" | "serviceRole">) {
  return pino({
    name: `airarena-arc-${config.serviceRole}`,
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
    base: { service: `airarena-arc-${config.serviceRole}`, network: "arc-testnet", chainId: 5_042_002 },
  });
}

export type Logger = ReturnType<typeof createLogger>;
