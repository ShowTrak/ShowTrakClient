/* eslint-disable no-empty -- UI actions are best-effort; a failed IPC call or
   missing element must never break the rest of the render. Matches the
   convention in src/main.ts. */
/**
 * @fileoverview
 * Handles the main UI logic for the ShowTrak Client application.
 *
 * - Updates the navbar title.
 * - Listens for profile updates and updates the profile display accordingly.
 * - Handles minimize and shutdown button events.
 *
 * Plain DOM through ./lib/dom: no jQuery, no Bootstrap JavaScript.
 */
import type {
  AppUpdateStatus,
  ClientProfile,
  ProcessMonitorStatus,
  ServerRecoveryStatus,
  UpdateChannel,
} from '@showtrak/protocol/client';
import {
  ADOPTION_BADGE_CLASSES,
  DEFAULT_SERVER_PORT,
  GetAdoptionBadgeModel,
  GetAppUpdateStatusText,
  GetManualServerModel,
  GetProcessMonitorWarningModel,
  GetProfileServerModel,
  GetServerRecoveryBannerModel,
} from './lib/status-models';
import {
  addClass,
  byId,
  isFocused,
  onOnly,
  removeClass,
  setText,
  setValue,
  toggleClass,
  valueOf,
} from './lib/dom';

let Profile: ClientProfile = {};
let UpdateChannelState: UpdateChannel = 'stable';

const UPDATE_CHANNEL_HINTS = {
  stable: 'Full releases only.',
  beta: 'Pre-releases as well: always the newest release of any kind. Switching back to Stable keeps this version until a newer full release is out.',
} as const;

function RenderUpdateChannel(): void {
  for (const Button of document.querySelectorAll<HTMLElement>('[data-update-channel]')) {
    Button.setAttribute(
      'aria-checked',
      String(Button.getAttribute('data-update-channel') === UpdateChannelState)
    );
  }
  setText(byId('UPDATE_CHANNEL_HINT'), UPDATE_CHANNEL_HINTS[UpdateChannelState]);
}
let Version = '0.0.0';
let ProcessMonitorStatusState: ProcessMonitorStatus = {
  State: 'unknown',
  Message: null,
  Platform: '',
};
let ServerRecoveryStatusState: ServerRecoveryStatus = { State: 'idle', Message: '' };

// Paint the profile panel.
//
// Text is set with textContent against the static structure in index.html rather
// than interpolated into markup: the UUID and endpoint come from a server payload, and
// building markup out of them made this an injection sink inside a
// context-isolated window for no benefit.
function ApplyProfile(NewProfile: ClientProfile | null | undefined): void {
  Profile = NewProfile || {};

  const AdoptionBadge = GetAdoptionBadgeModel(Profile, ServerRecoveryStatusState);
  const Badge = byId('PROFILE_ADOPTION_BADGE');
  removeClass(Badge, ADOPTION_BADGE_CLASSES);
  addClass(Badge, AdoptionBadge.className);
  setText(Badge, AdoptionBadge.label);

  const ServerModel = GetProfileServerModel(Profile);
  const ServerIP = byId('PROFILE_SERVER_IP');
  toggleClass(ServerIP, 'd-none', !ServerModel.hasServer);
  setText(ServerIP, ServerModel.ip);
  const ServerPort = byId('PROFILE_SERVER_PORT');
  toggleClass(ServerPort, 'd-none', !ServerModel.hasServer);
  setText(ServerPort, ServerModel.port);
  toggleClass(byId('PROFILE_SERVER_NONE'), 'd-none', ServerModel.hasServer);
  setText(byId('PROFILE_UUID'), ServerModel.uuid);

  RenderManualServer();
}

function ApplyAppUpdateStatus(payload: AppUpdateStatus | null | undefined): void {
  if (!payload || typeof payload !== 'object') return;
  try {
    removeClass(byId('UPDATE_SECTION'), 'd-none');
    addClass(byId('UPDATE_INSTALL_BTN'), 'd-none');
    addClass(byId('UPDATE_LATER_BTN'), 'd-none');
    addClass(byId('UPDATE_NOTES_WRAPPER'), 'd-none');
    setText(byId('UPDATE_CHANGELOG'), '');
    const StatusText = GetAppUpdateStatusText(payload);
    if (StatusText != null) setText(byId('UPDATE_STATUS'), StatusText);
  } catch {}
}

function RenderManualServerPortHint(): void {
  const Port = byId<HTMLInputElement>('MANUAL_SERVER_PORT');
  const Hint = byId('MANUAL_SERVER_HINT');
  if (!Port || !Hint) return;
  const isBlank = !valueOf(Port).trim();
  toggleClass(Hint, 'd-none', !isBlank);
}

function RenderProcessMonitorWarning(): void {
  const Warning = byId('PROCESS_MONITOR_WARNING');
  if (!Warning) return;
  const Model = GetProcessMonitorWarningModel(ProcessMonitorStatusState);
  toggleClass(Warning, 'd-none', !Model.visible);
  setText(Warning, Model.visible ? Model.text : '');
}

function RenderManualServer(): void {
  const Section = byId('MANUAL_SERVER_SECTION');
  const Status = byId('MANUAL_SERVER_STATUS');
  const Host = byId<HTMLInputElement>('MANUAL_SERVER_HOST');
  const Port = byId<HTMLInputElement>('MANUAL_SERVER_PORT');
  if (!Status || !Section) return;

  removeClass(Section, 'd-none');

  const Model = GetManualServerModel(Profile);
  removeClass(Status, Model.removeClass);
  addClass(Status, Model.addClass);
  setText(Status, Model.statusText);
  toggleClass(byId('BTN_MANUAL_SERVER_CLEAR'), 'd-none', !Model.isManual);
  if (!isFocused(Host)) setValue(Host, Model.host);
  if (!isFocused(Port)) setValue(Port, Model.port);
  RenderManualServerPortHint();
}

function RenderServerRecoveryStatus(): void {
  const Status = byId('SERVER_RECOVERY_STATUS');
  if (!Status) return;

  const Model = GetServerRecoveryBannerModel(ServerRecoveryStatusState);
  removeClass(Status, 'd-none alert-info alert-warning alert-success alert-danger');
  addClass(Status, Model.className);
  setText(Status, Model.text);
}

async function Main(): Promise<void> {
  window.API.OnAppUpdateStatus((payload) => {
    ApplyAppUpdateStatus(payload);
  });
  window.API.OnProcessMonitorStatus((status) => {
    ProcessMonitorStatusState = status || { State: 'unknown', Message: null, Platform: '' };
    RenderProcessMonitorWarning();
  });
  window.API.OnServerRecoveryStatus((status) => {
    ServerRecoveryStatusState = status || { State: 'idle', Message: '' };
    RenderServerRecoveryStatus();
    ApplyProfile(Profile);
  });
  // Pushed by the main process on every ProfileUpdated broadcast — adoption,
  // unadoption, a recovered endpoint, a manual server change. Registered here with
  // the other subscriptions rather than at module top level, so all renderer wiring
  // happens in one place.
  window.API.SetProfile(async (NewProfile) => {
    Version = await window.API.GetVersion();
    ApplyProfile(NewProfile);
  });

  const [LoadedErr, LoadedSnapshot] = (await window.API.Loaded()) || [];
  if (!LoadedErr && LoadedSnapshot && typeof LoadedSnapshot === 'object') {
    if (LoadedSnapshot.Profile) {
      ApplyProfile(LoadedSnapshot.Profile);
    }
    ProcessMonitorStatusState = LoadedSnapshot.ProcessMonitorStatus || {
      State: 'unknown',
      Message: null,
      Platform: '',
    };
    ServerRecoveryStatusState = LoadedSnapshot.ServerRecoveryStatus || {
      State: 'idle',
      Message: '',
    };
    ApplyAppUpdateStatus(LoadedSnapshot.AppUpdateStatus || null);
    UpdateChannelState = LoadedSnapshot.UpdateChannel === 'beta' ? 'beta' : 'stable';
  }
  Version = await window.API.GetVersion();
  setText(byId('APPLICATION_NAVBAR_TITLE'), `ShowTrak Client v${Version}`);
  RenderProcessMonitorWarning();
  RenderServerRecoveryStatus();
  RenderManualServer();
  RenderUpdateChannel();
  for (const Button of document.querySelectorAll<HTMLElement>('[data-update-channel]')) {
    onOnly(Button, 'click', async () => {
      const Next = Button.getAttribute('data-update-channel') === 'beta' ? 'beta' : 'stable';
      if (Next === UpdateChannelState) return;
      try {
        const [Err, Saved] = (await window.API.SetUpdateChannel(Next)) || [];
        if (!Err && Saved) UpdateChannelState = Saved;
      } catch {}
      RenderUpdateChannel();
    });
  }
  // Bind updater UI
  onOnly(byId('BTN_CHECK_UPDATES'), 'click', async () => {
    try {
      await window.API.CheckForAppUpdates();
    } catch {}
    removeClass(byId('UPDATE_SECTION'), 'd-none');
    setText(byId('UPDATE_STATUS'), 'Checking for updates…');
    addClass(byId('UPDATE_INSTALL_BTN'), 'd-none');
    addClass(byId('UPDATE_LATER_BTN'), 'd-none');
    addClass(byId('UPDATE_NOTES_WRAPPER'), 'd-none');
    setText(byId('UPDATE_CHANGELOG'), '');
  });
  onOnly(byId('UPDATE_INSTALL_BTN'), 'click', async () => {
    try {
      await window.API.InstallAppUpdate();
    } catch {}
  });
  onOnly(byId('UPDATE_LATER_BTN'), 'click', async () => {
    addClass(byId('UPDATE_SECTION'), 'd-none');
  });
  onOnly(byId('MANUAL_SERVER_PORT'), 'input', () => {
    RenderManualServerPortHint();
  });

  onOnly(byId('BTN_MANUAL_SERVER_SAVE'), 'click', async () => {
    const ErrorBox = byId('MANUAL_SERVER_ERROR');
    const ShowError = (Message: string) => {
      removeClass(ErrorBox, 'd-none');
      setText(ErrorBox, Message);
    };
    const host = valueOf(byId<HTMLInputElement>('MANUAL_SERVER_HOST')).trim();
    const portRaw = valueOf(byId<HTMLInputElement>('MANUAL_SERVER_PORT')).trim();
    const port = portRaw ? Number(portRaw) : DEFAULT_SERVER_PORT;
    addClass(ErrorBox, 'd-none');
    setText(ErrorBox, '');
    if (!host) {
      ShowError('Enter the server IP address or hostname.');
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ShowError('Enter a valid port between 1 and 65535.');
      return;
    }
    try {
      const [err] = (await window.API.SetManualServer(host, port)) || [];
      if (err) ShowError(String(err));
    } catch (error) {
      ShowError(String(error && (error as Error).message ? (error as Error).message : error));
    }
  });

  onOnly(byId('BTN_MANUAL_SERVER_CLEAR'), 'click', async () => {
    try {
      const ErrorBox = byId('MANUAL_SERVER_ERROR');
      addClass(ErrorBox, 'd-none');
      setText(ErrorBox, '');
      setValue(byId<HTMLInputElement>('MANUAL_SERVER_PORT'), DEFAULT_SERVER_PORT);
      RenderManualServerPortHint();
      await window.API.ClearManualServer();
    } catch (error) {
      console.error('Failed to clear manual server:', error);
    }
  });

  onOnly(byId('BTN_MINIMIZE'), 'click', async () => {
    window.API.Minimise();
  });

  onOnly(byId('BTN_SHUTDOWN'), 'click', async () => {
    window.API.Shutdown();
  });

  onOnly(byId('BTN_FACTORY_RESET'), 'click', async () => {
    const confirmed = window.confirm(
      'Factory reset ShowTrak Client? This clears adoption status and local client configuration.'
    );
    if (!confirmed) return;

    try {
      await window.API.ResetClientFactoryDefaults();
    } catch (error) {
      console.error('Factory reset failed:', error);
    }
  });
}

Main();
