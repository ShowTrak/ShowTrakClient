export async function Wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a `ServerIdentity`-shaped token off an arbitrary object.
 *
 * This ladder was written out by hand in eight places across six files, in two
 * subtly different flavours — some yielding `''` on absence, some `null`. That
 * difference matters: the identity check is what stops a recovering client
 * re-homing itself onto another operator's server on a shared LAN, and `''` vs
 * `null` decides whether "no identity advertised" reads as unconstrained or as a
 * mismatch.
 *
 * Returns the trimmed token, or `''` when the source is absent, not an object, or
 * the value is missing / blank / not a string. Call sites that need `null` write
 * `ReadIdentityToken(x) || null`, so the choice is visible at the site rather
 * than buried in one of two near-identical ladders.
 */
export function ReadIdentityToken(Source: unknown, Key = 'ServerIdentity'): string {
  if (!Source || typeof Source !== 'object') return '';
  const Value = (Source as Record<string, unknown>)[Key];
  return typeof Value === 'string' ? Value.trim() : '';
}

/**
 * Best-effort human-readable message for an unknown thrown value.
 *
 * Objects are read via `.message` and fall back when it is empty, rather than
 * being stringified: `String(new Error(''))` is the useless literal `'Error'`,
 * and `String({})` is `'[object Object]'` — both would show up verbatim in the
 * operator's status panel.
 *
 * Non-objects ARE stringified before the fallback, because several modules here
 * reject with a bare string and reporting the generic fallback instead would
 * discard the only diagnostic available.
 */
export function ErrorMessage(Err: unknown, Fallback = 'Unknown error'): string {
  if (Err && typeof Err === 'object') {
    const Message = (Err as { message?: unknown }).message;
    return Message ? String(Message) : Fallback;
  }
  if (Err) return String(Err);
  return Fallback;
}

/** The shape every telemetry delta takes: what appeared, what went, what moved. */
export interface KeyedDiff<T> {
  Added: T[];
  /** Keys of entries present before and absent now. */
  Removed: string[];
  Changed: T[];
}

/**
 * Diff two snapshots of a keyed collection.
 *
 * Used by every telemetry source that reports incrementally (network
 * interfaces, displays, running applications). Sharing one implementation keeps
 * the three deltas consistent about what "changed" means, and means the edge
 * cases — an entry with no usable key, a duplicate key within one snapshot —
 * are handled the same way everywhere rather than three times over.
 *
 * `key` identifies an entry across snapshots; entries it returns null for are
 * skipped entirely, since they can be neither tracked nor removed. `signature`
 * decides whether an entry that is present in both has actually changed.
 */
export function DiffByKey<T>(
  Previous: readonly T[],
  Next: readonly T[],
  key: (item: T) => string | null,
  signature: (item: T) => string
): KeyedDiff<T> {
  const previousByKey = new Map<string, T>();
  for (const item of Previous) {
    const Key = key(item);
    if (Key) previousByKey.set(Key, item);
  }

  const Added: T[] = [];
  const Changed: T[] = [];
  const seen = new Set<string>();

  for (const item of Next) {
    const Key = key(item);
    if (!Key || seen.has(Key)) continue;
    seen.add(Key);
    const before = previousByKey.get(Key);
    if (!before) {
      Added.push(item);
      continue;
    }
    if (signature(before) !== signature(item)) Changed.push(item);
  }

  const Removed: string[] = [];
  for (const Key of previousByKey.keys()) {
    if (!seen.has(Key)) Removed.push(Key);
  }

  return { Added, Removed, Changed };
}

/** Whether a diff carries nothing at all, and so is not worth emitting. */
export function IsEmptyDiff<T>(Diff: KeyedDiff<T>): boolean {
  return Diff.Added.length === 0 && Diff.Removed.length === 0 && Diff.Changed.length === 0;
}
