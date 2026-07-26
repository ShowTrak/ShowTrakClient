// IPC handler plumbing shared by every registration in ipc-handlers.ts.
//
// main.ts hand-rolled this preamble eleven times:
//
//   RPC.handle('X', async (_event, ...args) => {
//     try { assertNoArgs('X', args); } catch (error) { return validationErrorPayload(error); }
//     ...
//   });
//
// and in four other places wrote a second, subtly different shape that folded
// the real work into the same try block and logged before returning. `Handle`
// below covers both: the handler receives the raw args and may throw, and
// anything thrown becomes an [error, null] tuple so a rejected request never
// throws across the contextBridge.
//
// NOTE the return type is deliberately `unknown` rather than a tuple: most
// channels answer with a Go-style [error, value] tuple, but `GetVersion` returns
// a bare version string (the preload reads it as `string`), and that asymmetry
// is pre-existing wire behaviour the renderer depends on.

import { ipcMain } from 'electron';

import { CreateLogger } from '../Modules/Logger';

const Logger = CreateLogger('RPC');

// Reject any payload on a channel that takes none. The renderer is trusted only
// as far as the preload allowlist; an unexpected argument means the two sides
// have drifted, and failing loudly beats silently ignoring it.
function assertNoArgs(handlerName: string, args: unknown[]): void {
  if (args.length > 0) {
    throw new Error(`${handlerName} does not accept arguments`);
  }
}

function validationErrorPayload(error: unknown): [string, null] {
  const asError = error as { message?: unknown } | null | undefined;
  const message =
    asError && asError.message ? String(asError.message) : String(error || 'Invalid request');
  return [message, null];
}

interface HandleOptions {
  // Logged at error level when the handler throws. Present for the four channels
  // that previously logged inline before returning their error tuple; omitted
  // for the ones that only ever fail argument validation, which is not worth a
  // log line.
  errorLog?: string;
}

// Register an IPC channel. The handler validates its own arguments (via
// assertNoArgs, or by narrowing them itself) and may throw to reject.
function Handle(
  channel: string,
  handler: (args: unknown[]) => unknown,
  options: HandleOptions = {}
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await handler(args);
    } catch (Err) {
      if (options.errorLog) Logger.error(options.errorLog, Err);
      return validationErrorPayload(Err);
    }
  });
}

export { Handle, assertNoArgs, validationErrorPayload };
