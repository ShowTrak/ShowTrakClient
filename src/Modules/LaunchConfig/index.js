// Run-on-launch config helpers. The server is the single source of truth: the
// client fetches the config fresh on each connection and never persists it, so
// this module only normalizes an incoming payload and exposes the shared minimum
// delay. There is intentionally no disk cache.

// Minimum delay (seconds) enforced before a run-on-launch script fires. The
// delay doubles as the abort-window countdown, so it must stay long enough for
// an operator to cancel a destructive launch action. Mirrors the server-side
// MIN_LAUNCH_DELAY_SECONDS in IPCValidation.
const MIN_LAUNCH_DELAY_SECONDS = 10;

const Manager = {};

Manager.MIN_LAUNCH_DELAY_SECONDS = MIN_LAUNCH_DELAY_SECONDS;

// Coerce a server payload into a sanitized { ScriptID, DelaySeconds,
// ShowCountdown }. When a script is set, the delay is clamped to at least the
// minimum (defense in depth against a bad/stale server value); with no script,
// both are null. ShowCountdown is the server's global toggle for the on-screen
// abort countdown and defaults to true when the server omits it (older servers).
Manager.Normalize = (Input) => {
  const Source = Input && typeof Input === 'object' ? Input : {};
  const ScriptID =
    typeof Source.ScriptID === 'string' && Source.ScriptID.trim() ? Source.ScriptID.trim() : null;
  let DelaySeconds = Number(Source.DelaySeconds);
  if (!Number.isFinite(DelaySeconds) || DelaySeconds < 0) DelaySeconds = null;
  else DelaySeconds = Math.floor(DelaySeconds);
  if (ScriptID) {
    DelaySeconds = Math.max(MIN_LAUNCH_DELAY_SECONDS, DelaySeconds || MIN_LAUNCH_DELAY_SECONDS);
  } else {
    DelaySeconds = null;
  }
  const ShowCountdown = Source.ShowCountdown === undefined ? true : Source.ShowCountdown !== false;
  return { ScriptID, DelaySeconds, ShowCountdown };
};

module.exports = { Manager };
