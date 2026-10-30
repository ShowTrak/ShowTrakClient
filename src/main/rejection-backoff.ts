// Backoff for restarting after a different ShowTrak Server rejects us.
//
// An adopted client whose saved address now answers as another server (that
// server was reinstalled with a new identity, or another server took over the
// address) is told `Unadopt: server_identity_mismatch`. The client rightly
// ignores the unadopt, but it used to restart straight away, reach the same
// address, and be rejected again: around 80 times a second, for as long as
// both stayed up, costing both machines CPU and filling both logs.
//
// Each restart for this reason now waits: 2 s, then doubling to 30 s. A client
// left alone for RESET_MS starts again from the shortest wait, so a genuine
// recovery later on is not held back by an old run of rejections.

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const RESET_MS = 5 * 60 * 1000;

class RejectionBackoff {
  private Count = 0;
  private Last = 0;

  // Record a rejection at `Now` and return how long to wait before restarting.
  NextDelayMs(Now: number = Date.now()): number {
    if (this.Count === 0 || Now - this.Last > RESET_MS) this.Count = 0;
    this.Count++;
    this.Last = Now;
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.Count - 1, 15));
  }

  Reset(): void {
    this.Count = 0;
    this.Last = 0;
  }
}

export { RejectionBackoff, BASE_DELAY_MS, MAX_DELAY_MS, RESET_MS };
