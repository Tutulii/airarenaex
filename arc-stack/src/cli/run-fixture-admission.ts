import { loadConfig } from "../config.js";
import { createDatabase, migrateDatabase } from "../db.js";
import { runFixtureAdmissionCycle, type AdmissionRuntimeState } from "../fixture-admission.js";
import { createLogger } from "../logger.js";

const config = loadConfig(process.env);
if (config.serviceRole !== "middleman") throw new Error("fixture_admission_requires_middleman_role");
if (!config.fixtureAdmission.enabled) throw new Error("fixture_admission_not_enabled");
const logger = createLogger(config);
const db = createDatabase(config);
const state: AdmissionRuntimeState = {
  stopping: false,
  fixtureAdmissionLeader: true,
  lastFixtureAdmissionAt: null,
  lastFixtureAdmissionError: null,
  fixtureAdmissionScanned: 0,
  fixtureAdmissionAdmitted: 0,
};

try {
  await migrateDatabase(db, logger);
  const result = await runFixtureAdmissionCycle(config, db, logger, state);
  process.stdout.write(`${JSON.stringify({ success: true, result, state })}\n`);
} finally {
  await db.end();
}
