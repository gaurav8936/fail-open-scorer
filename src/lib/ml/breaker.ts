/**
 * Circuit breaker for the planner-ranker call (decision §1 "Ranker call"). After `threshold` consecutive failures the
 * breaker opens: calls are skipped (b = 0, no network) for `cooldownMs`. Then it half-opens and lets ONE trial through;
 * success closes it, failure re-opens it for another cooldown. Process-local by design (each app pod protects itself).
 */
export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(private readonly threshold = 5, private readonly cooldownMs = 30_000, private readonly now: () => number = Date.now) {}

  state(): BreakerState {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /** May a call go out now? In half-open, only one trial at a time. */
  allow(): boolean {
    const s = this.state();
    if (s === "closed") return true;
    if (s === "open") return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  success(): void { this.failures = 0; this.openedAt = null; this.trialInFlight = false; }

  failure(): void {
    this.trialInFlight = false;
    if (this.openedAt !== null) { this.openedAt = this.now(); return; } // failed trial → re-open
    if (++this.failures >= this.threshold) this.openedAt = this.now();
  }

  reset(): void { this.failures = 0; this.openedAt = null; this.trialInFlight = false; }
}
