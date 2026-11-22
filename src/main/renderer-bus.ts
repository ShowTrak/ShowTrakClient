// Single choke point for main -> renderer pushes.
//
// main.ts repeated this ten times:
//
//   if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, x);
//
// sometimes wrapped in try/catch and sometimes not, which is the kind of
// inconsistency that turns a mid-teardown push into an unhandled throw on one
// channel but not another. Routing every push through here makes the guard
// uniform and gives the extracted modules a way to talk to the renderer without
// each importing the window.
//
// The client has exactly one renderer surface (the config window), so unlike the
// Server's sink fan-out of the same name this is a direct send.

import type { PushChannel, PushMap } from '@showtrak/protocol/client';
import { CreateLogger } from '../Modules/Logger';
import { getMainWindow } from './app-window';

const Logger = CreateLogger('RendererBus');

// Push a channel + payload to the config window. Best-effort by design: the
// window is usually absent (the client normally runs as a tray-only agent), and
// a dropped status update must never take down the caller.
//
// Typed through PushMap in @showtrak/protocol/client, the same map the preload's
// subscriptions are typed through, so a channel and its payload cannot drift
// apart between the two processes.
function PushToRenderer<C extends PushChannel>(channel: C, ...args: PushMap[C]): void {
  const Window = getMainWindow();
  if (!Window || Window.isDestroyed()) return;
  try {
    Window.webContents.send(channel, ...args);
  } catch (Err) {
    Logger.debug(`Failed to push ${channel} to renderer`, String(Err));
  }
}

export { PushToRenderer };
