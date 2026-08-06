// IPC handler registrations for the config window.
//
// Every channel here must also be listed in the preload's INVOKE_CHANNELS
// allowlist (src/preload.ts) — that allowlist is the security boundary, this is
// the implementation behind it.
//
// Registered once, from main.ts, after app.whenReady().

import { app } from 'electron';

import { CreateLogger } from '../Modules/Logger';
import { Config } from '../Modules/Config';
import { Manager as ProcessMonitor } from '../Modules/ProcessMonitor';
import { Manager as ProfileManager } from '../Modules/ProfileManager';
import { Manager as ScriptManager } from '../Modules/ScriptManager';
import { Manager as VariableStore } from '../Modules/Variables';
import { Manager as IdentifyOverlay } from '../Modules/IdentifyOverlay';
import { Manager as LaunchCountdownOverlay } from '../Modules/LaunchCountdownOverlay';
import { Handle, assertNoArgs } from './rpc';
import { getMainWindow, hasMainWindow } from './app-window';
import { getRecoveryStatus } from './recovery-status';
import { getAppUpdateStatus, checkForUpdatesFromRenderer, installUpdate } from './app-updater';
import { restartService } from './service-lifecycle';

const Logger = CreateLogger('IPC');

function registerIpcHandlers(): void {
  // Everything the config window needs to paint its first frame.
  Handle('Loaded', async (args) => {
    assertNoArgs('Loaded', args);
    const Profile = await ProfileManager.GetProfile();
    return [
      null,
      {
        Profile,
        ProcessMonitorStatus: ProcessMonitor.GetStatus(),
        ServerRecoveryStatus: getRecoveryStatus(),
        AppUpdateStatus: getAppUpdateStatus(),
      },
    ];
  });

  Handle('Minimise', (args) => {
    assertNoArgs('Minimise', args);
    const Window = getMainWindow();
    if (hasMainWindow() && Window?.isVisible()) {
      Window.hide();
    }
    return [null, true];
  });

  Handle('Shutdown', (args) => {
    assertNoArgs('Shutdown', args);
    app.quit();
    return [null, true];
  });

  // Called by the identify overlay renderer when the user presses Escape or
  // clicks anywhere. We close all overlay windows and notify the socket layer.
  Handle('Identify:Close', (args) => {
    assertNoArgs('Identify:Close', args);
    IdentifyOverlay.HandleUserClose();
    return [null, true];
  });

  // Called by the launch countdown overlay renderer when the operator aborts the
  // pending run-on-launch script (Cancel button, Esc, or Shift).
  Handle('LaunchCountdown:Cancel', (args) => {
    assertNoArgs('LaunchCountdown:Cancel', args);
    LaunchCountdownOverlay.HandleUserCancel();
    return [null, true];
  });

  // NOTE: answers with a bare string, not an [error, value] tuple. Pre-existing
  // wire behaviour the renderer depends on (`GetVersion(): Promise<string>`).
  Handle('GetVersion', (args) => {
    assertNoArgs('GetVersion', args);
    return Config.Application.Version;
  });

  Handle(
    'Profile:FactoryReset',
    async (args) => {
      assertNoArgs('Profile:FactoryReset', args);
      await ProfileManager.ResetProfileToFactoryDefaults();
      await ScriptManager.DeleteScripts();
      // Take the show's variables with it, including anything exported to the
      // Windows user environment — a factory-reset machine must not keep the
      // previous show's values in its registry.
      await VariableStore.Clear();
      await restartService('factory-reset');
      return [null, true];
    },
    { errorLog: 'Factory reset failed' }
  );

  Handle(
    'Profile:SetManualServer',
    async (args) => {
      const [Host, Port] = args;
      const NormalizedHost = typeof Host === 'string' ? Host.trim() : '';
      if (!NormalizedHost) {
        throw new Error('A server host or IP address is required.');
      }
      const NormalizedPort = Number(Port);
      if (!Number.isInteger(NormalizedPort) || NormalizedPort < 1 || NormalizedPort > 65535) {
        throw new Error('A valid server port between 1 and 65535 is required.');
      }
      await ProfileManager.SetManualServer(NormalizedHost, NormalizedPort);
      await restartService('manual-server-set');
      return [null, true];
    },
    { errorLog: 'Failed to set manual server endpoint' }
  );

  Handle(
    'Profile:ClearManualServer',
    async (args) => {
      assertNoArgs('Profile:ClearManualServer', args);
      await ProfileManager.ClearManualServer();
      await restartService('manual-server-clear');
      return [null, true];
    },
    { errorLog: 'Failed to clear manual server endpoint' }
  );

  Handle('AppUpdate:Check', async (args) => {
    assertNoArgs('AppUpdate:Check', args);
    await checkForUpdatesFromRenderer();
    return [null, true];
  });

  Handle(
    'AppUpdate:Install',
    (args) => {
      assertNoArgs('AppUpdate:Install', args);
      installUpdate();
      return [null, true];
    },
    { errorLog: 'App update install failed' }
  );

  Logger.log('IPC handlers registered');
}

export { registerIpcHandlers };
