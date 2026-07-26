// Run-on-launch orchestration (main-process half).
//
// MainClient fires 'RunLaunchAction' once per client launch, after the FIRST
// successful server connection and after it has re-synced the script catalog and
// the auto-start settings. This module owns what happens next: the cancellable
// countdown, then execution.
//
// Extracted from main.ts unchanged.

import fs from 'fs';
import path from 'path';

import type { LaunchConfigPayload } from '@showtrak/protocol';

import { CreateLogger } from '../Modules/Logger';
import { Manager as AppDataManager } from '../Modules/AppData';
import { Manager as LaunchConfigManager } from '../Modules/LaunchConfig';
import { Manager as LaunchCountdownOverlay } from '../Modules/LaunchCountdownOverlay';
import { Manager as ScriptManager } from '../Modules/ScriptManager';
import { Wait } from '../Modules/Utils';

const Logger = CreateLogger('LaunchActions');

// Guards against re-running the launch action within a single process. MainClient
// has its own `launchSequenceStarted` guard for the same invariant on its side of
// the boundary — the pair is deliberate belt-and-braces, so do not remove one on
// the assumption the other covers it.
let LaunchActionsHandled = false;

// Presence-of-file sentinel: dropping a file named `SafeMode` into the profile
// directory disables ALL launch actions. This is the boot-loop escape hatch for
// the headless case where the countdown overlay isn't reliably seen — a tech can
// create the file over the network (or from a recovery shell) and stop a
// misbehaving run-on-launch script without uninstalling the client.
function IsSafeModeEnabled(): boolean {
  try {
    return fs.existsSync(path.join(AppDataManager.GetProfileDirectory(), 'SafeMode'));
  } catch {
    return false;
  }
}

// Run the configured run-on-launch script, gated behind a cancellable countdown.
// Self-guarded, so any accidental repeat (a reconnect, a service restart) is a
// no-op and the script runs at most once per launch.
async function RunLaunchActions(Config: LaunchConfigPayload): Promise<void> {
  if (LaunchActionsHandled) return;
  LaunchActionsHandled = true;

  try {
    if (IsSafeModeEnabled()) {
      Logger.warn('Safe mode enabled (SafeMode sentinel present) — skipping launch actions');
      return;
    }

    const { ScriptID, DelaySeconds, ShowCountdown } = LaunchConfigManager.Normalize(Config);
    if (!ScriptID) return;

    const LaunchState = ScriptManager.GetLaunchState(ScriptID);
    if (!LaunchState.Found) {
      Logger.warn(`Run-on-launch script ${ScriptID} not found in catalog — skipping`);
      return;
    }
    if (!LaunchState.Enabled) {
      Logger.warn(
        `Run-on-launch script ${ScriptID} is not runnable: ${LaunchState.DisabledReason} — skipping`
      );
      return;
    }

    const Delay = Math.max(
      LaunchConfigManager.MIN_LAUNCH_DELAY_SECONDS,
      Number(DelaySeconds) || LaunchConfigManager.MIN_LAUNCH_DELAY_SECONDS
    );

    Logger.log(`Run-on-launch: "${LaunchState.Name}" scheduled in ${Delay}s`);

    if (ShowCountdown) {
      const Outcome = await LaunchCountdownOverlay.Show({
        ScriptName: LaunchState.Name,
        Seconds: Delay,
      });

      if (Outcome === 'cancelled') {
        Logger.warn(`Run-on-launch action "${LaunchState.Name}" cancelled by operator`);
        return;
      }
    } else {
      // Server disabled the visible countdown: honor the delay silently so the
      // script still fires on schedule, but with no overlay and no abort window.
      Logger.log('Run-on-launch: countdown overlay disabled by server — waiting silently');
      await Wait(Delay * 1000);
    }

    Logger.log(`Run-on-launch: executing "${LaunchState.Name}"`);
    const [Err] = await ScriptManager.Execute('launch', ScriptID);
    if (Err) Logger.error(`Run-on-launch execution failed: ${Err}`);
  } catch (Err) {
    Logger.error('RunLaunchActions failed', Err);
  }
}

export { IsSafeModeEnabled, RunLaunchActions };
