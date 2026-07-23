export const CANCELLATION_CUTOFF_MS = 200n;

export function cancellationCutoffMs(batchEndMs: bigint): bigint {
  if (batchEndMs < CANCELLATION_CUTOFF_MS) throw new Error("batch_end_before_cancellation_cutoff");
  return batchEndMs - CANCELLATION_CUTOFF_MS;
}

export function cancellationWindowOpen(nowMs: bigint, cutoffMs: bigint): boolean {
  return nowMs < cutoffMs;
}
