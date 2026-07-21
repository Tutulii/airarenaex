import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export function createMetrics(service: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ service, network: "arc-testnet" });
  collectDefaultMetrics({ register: registry, prefix: "airarena_arc_" });
  const jobsProcessed = new Counter({
    name: "airarena_arc_jobs_processed_total",
    help: "Arc jobs processed by result",
    labelNames: ["kind", "result"] as const,
    registers: [registry],
  });
  const indexerBlock = new Gauge({
    name: "airarena_arc_indexer_block",
    help: "Latest indexed Arc block",
    registers: [registry],
  });
  const resultWatcherLeader = new Gauge({
    name: "airarena_arc_result_watcher_leader",
    help: "Whether this replica owns the autonomous settlement watcher lease",
    registers: [registry],
  });
  const resultObservations = new Counter({
    name: "airarena_arc_result_observations_total",
    help: "TxLINE result observations by validation result",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const autoSettlementsEnqueued = new Counter({
    name: "airarena_arc_auto_settlements_enqueued_total",
    help: "Trusted TxLINE final outcomes enqueued for autonomous Arc resolution",
    registers: [registry],
  });
  return {
    registry,
    jobsProcessed,
    indexerBlock,
    resultWatcherLeader,
    resultObservations,
    autoSettlementsEnqueued,
  };
}
