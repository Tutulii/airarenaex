import { loadConfig } from "../config.js";
import { bindDatabaseToExchange, createDatabase, migrateDatabase } from "../db.js";
import { createLogger } from "../logger.js";

const config = loadConfig();
const logger = createLogger(config);
const db = createDatabase(config);

try {
  await migrateDatabase(db, logger);
  if (config.exchangeAddress) await bindDatabaseToExchange(db, config.chainId, config.exchangeAddress);
  logger.info("arc_database_migrations_complete");
} finally {
  await db.end();
}
