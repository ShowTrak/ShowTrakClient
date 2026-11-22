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
// Each handler answers its channel's declared result: InvokeMap (the config
// window) and OverlayInvokeMap (the overlay windows) in
// @showtrak/protocol/client, the maps the preloads are typed through. Most
// channels answer with an [error, value] tuple, but `GetVersion` answers with a
// bare version string, a pre-existing asymmetry the renderer depends on; the map
// declares it that way. The arguments stay `unknown[]` whatever the map says,
// because the renderer is untrusted: every handler narrows its own.

import { ipcMain } from 'electron';

import type { InvokeMap, OverlayInvokeMap } from '@showtrak/protocol/client';
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

/** Every channel the main process answers, from any of its windows. */
type HandledMap = InvokeMap & OverlayInvokeMap;
type HandledChannel = keyof HandledMap;

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
// assertNoArgs, or by narrowing them itself) and may throw to reject; a throw
// answers [message, null] (only `GetVersion` declares no such answer, and it
// throws only when called with arguments, which its preload method never passes).
function Handle<C extends HandledChannel>(
  channel: C,
  handler: (args: unknown[]) => HandledMap[C]['Result'] | Promise<HandledMap[C]['Result']>,
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
