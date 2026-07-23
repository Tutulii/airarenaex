import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PostgreSQL integration suites share one explicitly provisioned ephemeral
    // database. File-level parallelism can let one suite seal another suite's
    // batch, producing nondeterministic evidence rather than testing runtime
    // behavior. Individual pure/unit tests still run normally within a file.
    fileParallelism: false,
  },
});
