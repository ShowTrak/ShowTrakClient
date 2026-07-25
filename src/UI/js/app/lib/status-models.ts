// Pure status derivations for the client config window.
//
// Extracted from main.ts so the rules that decide what the operator sees on a
// client machine can be tested without a DOM. Each function takes plain state
// and returns a plain model; main.ts keeps the jQuery that paints it.
//
// This window is often the ONLY thing a venue tech looks at on a client PC. If
// it says "Adopted, Connected" while the socket is down, or hides an
// application-monitoring permission failure, the machine looks healthy while
// silently not doing its job.

import type { ClientProfile, ProcessMonitorStatus } from '../../../../types/client';
import type { AppUpdateStatus, ServerRecoveryStatus } from '../../../../types/preload';

export const DEFAULT_SERVER_PORT = 3000;

export interface BadgeModel {
  label: string;
  className: string;
}

/**
 * Read a recovery status into (normalised state, trimmed message).
 *
 * Shared by the badge and the banner so the two can never disagree about
 * whether the client is connected — which would put a green badge above a red
 * banner.
 */
function readRecovery(Status: ServerRecoveryStatus | null | undefined): {
  state: string;
  message: string;
} {
  const state = String(Status && Status.State ? Status.State : 'idle').toLowerCase();
  const message = Status && typeof Status.Message === 'string' ? Status.Message.trim() : '';
  return { state, message };
}

/**
 * The adoption badge: the headline status of this client.
 *
 * Unadopted outranks everything — a client with no server cannot be connected
 * to one, whatever a stale recovery status says.
 */
export function GetAdoptionBadgeModel(
  Profile: ClientProfile | null | undefined,
  Recovery: ServerRecoveryStatus | null | undefined
): BadgeModel {
  if (!Profile || !Profile.Adopted || !Profile.Server) {
    return { label: 'Pending Adoption', className: 'bg-primary' };
  }

  const { state, message } = readRecovery(Recovery);
  const isConnected = !message || state === 'idle' || state === 'reconnected';

  return isConnected
    ? { label: 'Adopted, Connected', className: 'bg-success' }
    : { label: 'Adopted, Disconnected', className: 'bg-danger' };
}

export interface RecoveryBannerModel {
  text: string;
  className: string;
}

/**
 * The recovery banner beneath the badge.
 *
 * Note the deliberate asymmetry with the badge: 'reconnected' counts as
 * connected for the BADGE but still shows its message here, so the operator can
 * see that a recovery happened rather than having it silently vanish.
 */
export function GetServerRecoveryBannerModel(
  Recovery: ServerRecoveryStatus | null | undefined
): RecoveryBannerModel {
  const { state, message } = readRecovery(Recovery);
  const isConnectedState = !message || state === 'idle';
  const text = isConnectedState ? 'Connected to ShowTrak Server' : message;

  let className: string;
  if (state === 'recoveryfailed') className = 'alert-danger';
  else if (state === 'primaryfailed') className = 'alert-warning';
  else if (state === 'reconnected' || isConnectedState) className = 'alert-success';
  else className = 'alert-info';

  return { text, className };
}

export interface ProcessMonitorWarningModel {
  visible: boolean;
  text: string;
}

/**
 * The application-monitoring warning.
 *
 * Only shown for the two states the operator can act on. macOS in particular
 * needs an explicit permission grant, and without this warning the client
 * reports an empty application list forever while looking perfectly healthy —
 * so every critical-application alert silently stops working.
 */
export function GetProcessMonitorWarningModel(
  Status: ProcessMonitorStatus | null | undefined
): ProcessMonitorWarningModel {
  const state = String(Status && Status.State ? Status.State : 'unknown').toLowerCase();
  const message = Status && typeof Status.Message === 'string' ? Status.Message.trim() : '';

  if (state === 'permission_denied' || state === 'error') {
    return {
      visible: true,
      text:
        message ||
        'Application monitoring is unavailable. Check system permissions for ShowTrak Client.',
    };
  }
  return { visible: false, text: '' };
}

/**
 * The status line for the app updater, or null when the payload says nothing.
 *
 * Null means "leave the panel alone" rather than "clear it" — a malformed push
 * must not wipe a message the operator is mid-way through reading.
 */
export function GetAppUpdateStatusText(Payload: AppUpdateStatus | null | undefined): string | null {
  if (!Payload || typeof Payload !== 'object') return null;

  const State = Payload.state || 'none';
  switch (State) {
    case 'checking':
      return 'Checking for updates...';
    case 'available': {
      const Version =
        (Payload.info && (Payload.info.version || Payload.info.tag)) || 'Update available';
      return `Update available: ${Version}. Downloading...`;
    }
    case 'downloading': {
      const Percent = Payload.percent ? Math.floor(Payload.percent) : 0;
      return `Downloading update... ${Percent}%`;
    }
    case 'downloaded':
      return 'Update downloaded. Restarting to apply...';
    case 'installing':
      return 'Installing update...';
    case 'installed':
      return 'Update installed. Restarting...';
    case 'none':
      return 'No updates available';
    case 'error':
      return `Update error: ${Payload.error || 'Unknown error'}`;
    default:
      return null;
  }
}

export interface ManualServerModel {
  isManual: boolean;
  host: string;
  port: number;
  statusText: string;
  addClass: string;
  removeClass: string;
}

/**
 * The manual-server panel.
 *
 * A manual endpoint is the only way a client on a routed or VLAN'd network can
 * reach its server, since mDNS cannot cross the boundary — so whether one is
 * set has to be unambiguous on screen.
 */
export function GetManualServerModel(Profile: ClientProfile | null | undefined): ManualServerModel {
  const Manual = Profile && Profile.ManualServer ? Profile.ManualServer : null;

  if (Manual && Manual.Host) {
    return {
      isManual: true,
      host: String(Manual.Host),
      port: Number(Manual.Port) || DEFAULT_SERVER_PORT,
      statusText: 'Manual',
      addClass: 'bg-success',
      removeClass: 'bg-secondary',
    };
  }

  return {
    isManual: false,
    host: '',
    port: DEFAULT_SERVER_PORT,
    statusText: 'Not Set',
    addClass: 'bg-secondary',
    removeClass: 'bg-success',
  };
}
