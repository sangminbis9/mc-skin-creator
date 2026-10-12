// Audit-only lifecycle. It never opens a request gate or retries a provider.
export type AuditShutdownSnapshot = {
  phase: "capturing" | "draining" | "finalizing" | "finalized";
  qClaimed: boolean;
  qDispatched: boolean;
  qFailed: boolean;
};
type ShutdownActions = {
  ownerAlive(): boolean;
  registrationProven(): boolean;
  checkpointIntent(): Promise<void>;
  sendQ(): void;
  onFailure(): void;
};

export class AuditShutdownLatch {
  private state: AuditShutdownSnapshot;
  private qTask: Promise<void> | null = null;
  constructor(private readonly actions: ShutdownActions, recovered?: AuditShutdownSnapshot) {
    // Recovery is evidence inspection, never permission to resume a consumed run.
    this.state = recovered ? { ...recovered, phase: "finalized" }
      : { phase: "capturing", qClaimed: false, qDispatched: false, qFailed: false };
  }
  snapshot(): AuditShutdownSnapshot { return { ...this.state }; }
  get acceptsEvents(): boolean { return ["capturing", "draining"].includes(this.state.phase); }
  assertCapturing(): void {
    if (this.state.phase !== "capturing") throw new Error("audit_run_consumed");
  }
  beginShutdown(): void {
    this.assertCapturing();
    this.state.phase = "draining";
  }
  tryQ(): Promise<void> {
    if (this.qTask) return this.qTask;
    if (this.state.phase !== "draining" || !this.actions.ownerAlive() || !this.actions.registrationProven())
      return Promise.resolve();
    // Claim synchronously, before checkpoint IO, so duplicate late events cannot
    // enqueue a second q. A failed checkpoint/send is terminal, not retryable.
    this.state.qClaimed = true;
    this.qTask = Promise.resolve().then(async () => {
      await this.actions.checkpointIntent();
      if (this.state.phase !== "draining" || !this.actions.ownerAlive()) return;
      this.actions.sendQ();
      this.state.qDispatched = true;
    }).catch(() => { this.state.qFailed = true; this.actions.onFailure(); });
    return this.qTask;
  }
  beginFinalization(): void {
    if (this.state.phase !== "draining") throw new Error("audit_finalization_order_invalid");
    this.state.phase = "finalizing";
  }
  finalize(): void {
    if (this.state.phase !== "finalizing") throw new Error("audit_finalization_order_invalid");
    this.state.phase = "finalized";
  }
}
