import { loadConfig } from "../config.js";
import { createDatabase, migrateDatabase } from "../db.js";
import { createLogger } from "../logger.js";

const config = loadConfig();
const logger = createLogger(config);
const db = createDatabase(config);

try {
  await migrateDatabase(db, logger);
  logger.info("arc_database_migrations_complete");
} finally {
  await db.end();
}
