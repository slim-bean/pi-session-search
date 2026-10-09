/** Local model-call diagnostics only; never serialize a signal or transport options. */
export function modelDeadline(signals: AbortSignal[], timeoutMs = 600_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new Error("Model timeout must be 1–3600000 milliseconds");
  const started = Date.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([...signals, deadline]);
  const diagnostics = (stopReason?: string, errorMessage?: string) => {
    const reason = signal.reason;
    const abortReason = signal.aborted
      ? deadline.aborted && reason === deadline.reason
        ? `Model call timed out after ${timeoutMs / 1000}s`
        : reason instanceof Error ? reason.message : String(reason ?? "Cancellation requested; cause unavailable")
      : stopReason === "aborted" ? errorMessage || "Provider returned aborted without a local cancellation; cause not supplied" : undefined;
    return { timeoutMs, elapsedMs: Date.now() - started, abortReason };
  };
  return { signal, diagnostics };
}
