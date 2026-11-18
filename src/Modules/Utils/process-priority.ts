import os from 'node:os';

/**
 * Run a helper process the client spawned at below-normal priority.
 *
 * The client's samplers (PowerShell hosts, nvidia-smi, system_profiler…) are
 * background work on a machine whose real job is the show; any contention for
 * the CPU should go the show's way. Only HELPERS are lowered: the client's own
 * process keeps its priority, because the scripts it launches (often the show
 * itself) inherit it.
 *
 * Best effort and silent: the child may already have exited, the platform may
 * refuse, and none of that is worth a log line or a failed sample. Accepts
 * anything with a numeric `pid`, so test doubles without one are ignored.
 */
export function LowerChildPriority(Child: unknown): void {
  const Pid = Child && typeof Child === 'object' ? (Child as { pid?: unknown }).pid : undefined;
  if (typeof Pid !== 'number' || !Number.isInteger(Pid) || Pid <= 0) return;
  try {
    os.setPriority(Pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (_error) {
    // Exited already, or not ours to change.
  }
}
