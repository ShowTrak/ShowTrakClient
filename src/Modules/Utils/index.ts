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
