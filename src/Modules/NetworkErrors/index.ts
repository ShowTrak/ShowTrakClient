// Central classifier for transient/benign network errors.
//
// When the host loses connectivity — Ethernet unplugged, Wi-Fi turned off, a VPN
// dropping, a NIC being removed — sockets that were mid-flight throw system
// errors from deep inside libuv/Node that our own try/catch blocks can't wrap
// (they surface asynchronously in a dgram send callback or a socket 'error'
// event). The canonical symptom on this client is the mDNS discovery browser
// throwing:
//
//     Error: send EADDRNOTAVAIL 224.0.0.251:5353
//         at doSend (node:dgram:...)
//
// These are expected, self-healing conditions: discovery restarts and the
// socket.io client reconnects once connectivity returns. So instead of crashing
// the agent we recognise this class of error in one place and downgrade it to a
// logged warning.
//
// Mirrors the classifier in ShowTrakServer (src/Modules/NetworkErrors); the two
// apps are separate packages and the shared submodule carries types only, so the
// logic is intentionally duplicated rather than shared.

// System error codes that all mean "the network went away / is unreachable" or
// "the stream is being torn down". None indicate a bug on our side; every one is
// recoverable once connectivity is restored (or is a harmless teardown race).
export const TRANSIENT_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'EADDRNOTAVAIL', // the bound source address vanished (interface gone)
  'ENETUNREACH', // no route to the network (e.g. all interfaces down)
  'ENETDOWN', // the network interface is administratively/physically down
  'ENETRESET', // connection aborted by the network
  'EHOSTUNREACH', // no route to host
  'EHOSTDOWN', // host is down
  'ENODEV', // no such device (interface removed out from under us)
  'EPIPE', // broken pipe during a send — also a closed stdout when run detached
  'ECONNRESET', // peer/ICMP reset
  'ECONNREFUSED', // ICMP port-unreachable surfaced on a prior UDP send
  'ERR_SOCKET_DGRAM_NOT_RUNNING', // sent on a dgram socket that is already closing
  'ERR_SOCKET_CANNOT_SEND', // dgram send attempted after teardown
]);

// Pull a system error code off an unknown throwable. Node puts it on `.code`;
// as a fallback we scan the message for a known token (some libraries wrap the
// original error and only preserve the text, e.g. "send EADDRNOTAVAIL ...").
function ExtractCode(Err: unknown): string | null {
  if (!Err || typeof Err !== 'object') {
    // A bare string like "send EADDRNOTAVAIL 224.0.0.251:5353" can still be classified.
    if (typeof Err === 'string') {
      for (const Code of TRANSIENT_NETWORK_ERROR_CODES) {
        if (Err.includes(Code)) return Code;
      }
    }
    return null;
  }
  const Code = (Err as { code?: unknown }).code;
  if (typeof Code === 'string' && Code) return Code;
  const Message = (Err as { message?: unknown }).message;
  if (typeof Message === 'string') {
    for (const Candidate of TRANSIENT_NETWORK_ERROR_CODES) {
      if (Message.includes(Candidate)) return Candidate;
    }
  }
  return null;
}

// True when an error is a transient/benign network condition that should be
// logged-and-ignored rather than crashing the process.
export function IsTransientNetworkError(Err: unknown): boolean {
  const Code = ExtractCode(Err);
  return Code != null && TRANSIENT_NETWORK_ERROR_CODES.has(Code);
}

// Human-readable one-liner for logs.
export function DescribeError(Err: unknown): string {
  if (Err && typeof Err === 'object' && 'message' in Err) {
    const M = (Err as { message?: unknown }).message;
    if (typeof M === 'string' && M) return M;
  }
  return String(Err);
}
