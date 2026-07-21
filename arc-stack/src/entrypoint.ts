import { startApi } from "./api.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startMcp } from "./mcp.js";
import { startMiddleman } from "./middleman.js";

const config = loadConfig();
const logger = createLogger(config);

process.on("unhandledRejection", (error) => {
  logger.fatal({ err: error }, "unhandled_rejection");
  process.exitCode = 1;
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught_exception");
  process.exit(1);
});

try {
  if (config.serviceRole === "api") await startApi(config, logger);
  else if (config.serviceRole === "middleman") await startMiddleman(config, logger);
  else await startMcp(config, logger);
} catch (error) {
  logger.fatal({ err: error, role: config.serviceRole }, "arc_service_startup_failed");
  process.exit(1);
}
