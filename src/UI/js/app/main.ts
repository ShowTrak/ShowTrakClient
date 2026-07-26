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
 * jQuery and Bootstrap are external <script> globals, not bundled here.
 */
import type { ClientProfile, ProcessMonitorStatus } from '../../../types/client';
import type { AppUpdateStatus, ServerRecoveryStatus } from '../../../types/preload';
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

let Profile: ClientProfile = {};
let Version = '0.0.0';
let ProcessMonitorStatusState: ProcessMonitorStatus = {
  State: 'unknown',
  Message: null,
  Platform: '',
};
let ServerRecoveryStatusState: ServerRecoveryStatus = { State: 'idle', Message: '' };

// Paint the profile panel.
//
// Text is set with .text() against the static structure in index.html rather than
// interpolated into .html(): the UUID and endpoint come from a server payload, and
// building markup out of them made this an injection sink inside a
// context-isolated window for no benefit.
function ApplyProfile(NewProfile: ClientProfile | null | undefined): void {
  Profile = NewProfile || {};

  const AdoptionBadge = GetAdoptionBadgeModel(Profile, ServerRecoveryStatusState);
  $('#PROFILE_ADOPTION_BADGE')
    .removeClass(ADOPTION_BADGE_CLASSES)
    .addClass(AdoptionBadge.className)
    .text(AdoptionBadge.label);

  const ServerModel = GetProfileServerModel(Profile);
  $('#PROFILE_SERVER_IP').toggleClass('d-none', !ServerModel.hasServer).text(ServerModel.ip);
  $('#PROFILE_SERVER_PORT').toggleClass('d-none', !ServerModel.hasServer).text(ServerModel.port);
  $('#PROFILE_SERVER_NONE').toggleClass('d-none', ServerModel.hasServer);
  $('#PROFILE_UUID').text(ServerModel.uuid);

  RenderManualServer();
}

function ApplyAppUpdateStatus(payload: AppUpdateStatus | null | undefined): void {
  if (!payload || typeof payload !== 'object') return;
  try {
    $('#UPDATE_SECTION').removeClass('d-none');
    const $status = $('#UPDATE_STATUS');
    const $install = $('#UPDATE_INSTALL_BTN');
    const $later = $('#UPDATE_LATER_BTN');
    const $notesWrap = $('#UPDATE_NOTES_WRAPPER');
    const $notes = $('#UPDATE_CHANGELOG');
    $install.addClass('d-none');
    $later.addClass('d-none');
    $notesWrap.addClass('d-none');
    $notes.empty();
    const StatusText = GetAppUpdateStatusText(payload);
    if (StatusText != null) $status.text(StatusText);
  } catch {}
}

function RenderManualServerPortHint(): void {
  const $port = $('#MANUAL_SERVER_PORT');
  const $hint = $('#MANUAL_SERVER_HINT');
  if (!$port.length || !$hint.length) return;
  const isBlank = !String($port.val() || '').trim();
  $hint.toggleClass('d-none', !isBlank);
}

function RenderProcessMonitorWarning(): void {
  const $warning = $('#PROCESS_MONITOR_WARNING');
  if (!$warning || !$warning.length) return;
  const Model = GetProcessMonitorWarningModel(ProcessMonitorStatusState);
  if (Model.visible) {
    $warning.removeClass('d-none').text(Model.text);
    return;
  }
  $warning.addClass('d-none').text('');
}

function RenderManualServer(): void {
  const $section = $('#MANUAL_SERVER_SECTION');
  const $status = $('#MANUAL_SERVER_STATUS');
  const $clear = $('#BTN_MANUAL_SERVER_CLEAR');
  const $host = $('#MANUAL_SERVER_HOST');
  const $port = $('#MANUAL_SERVER_PORT');
  if (!$status.length || !$section.length) return;

  $section.removeClass('d-none');

  const Model = GetManualServerModel(Profile);
  $status.removeClass(Model.removeClass).addClass(Model.addClass).text(Model.statusText);
  $clear.toggleClass('d-none', !Model.isManual);
  if (!$host.is(':focus')) $host.val(Model.host);
  if (!$port.is(':focus')) $port.val(Model.port);
  RenderManualServerPortHint();
}

function RenderServerRecoveryStatus(): void {
  const $status = $('#SERVER_RECOVERY_STATUS');
  if (!$status || !$status.length) return;

  const Model = GetServerRecoveryBannerModel(ServerRecoveryStatusState);
  $status.removeClass('d-none alert-info alert-warning alert-success alert-danger');
  $status.addClass(Model.className);
  $status.text(Model.text);
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
  }
  Version = await window.API.GetVersion();
  $('#APPLICATION_NAVBAR_TITLE').text(`ShowTrak Client v${Version}`);
  RenderProcessMonitorWarning();
  RenderServerRecoveryStatus();
  RenderManualServer();
  // Bind updater UI
  $('#BTN_CHECK_UPDATES')
    .off('click')
    .on('click', async () => {
      try {
        await window.API.CheckForAppUpdates();
      } catch {}
      $('#UPDATE_SECTION').removeClass('d-none');
      $('#UPDATE_STATUS').text('Checking for updates...');
      $('#UPDATE_INSTALL_BTN').addClass('d-none');
      $('#UPDATE_LATER_BTN').addClass('d-none');
      $('#UPDATE_NOTES_WRAPPER').addClass('d-none');
      $('#UPDATE_CHANGELOG').empty();
    });
  $('#UPDATE_INSTALL_BTN')
    .off('click')
    .on('click', async () => {
      try {
        await window.API.InstallAppUpdate();
      } catch {}
    });
  $('#UPDATE_LATER_BTN')
    .off('click')
    .on('click', async () => {
      $('#UPDATE_SECTION').addClass('d-none');
    });
  $('#MANUAL_SERVER_PORT')
    .off('input')
    .on('input', () => {
      RenderManualServerPortHint();
    });

  $('#BTN_MANUAL_SERVER_SAVE')
    .off('click')
    .on('click', async () => {
      const $error = $('#MANUAL_SERVER_ERROR');
      const host = String($('#MANUAL_SERVER_HOST').val() || '').trim();
      const portRaw = String($('#MANUAL_SERVER_PORT').val() || '').trim();
      const port = portRaw ? Number(portRaw) : DEFAULT_SERVER_PORT;
      $error.addClass('d-none').text('');
      if (!host) {
        $error.removeClass('d-none').text('Enter the server IP address or hostname.');
        return;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        $error.removeClass('d-none').text('Enter a valid port between 1 and 65535.');
        return;
      }
      try {
        const [err] = (await window.API.SetManualServer(host, port)) || [];
        if (err) {
          $error.removeClass('d-none').text(String(err));
        }
      } catch (error) {
        $error
          .removeClass('d-none')
          .text(String(error && (error as Error).message ? (error as Error).message : error));
      }
    });

  $('#BTN_MANUAL_SERVER_CLEAR')
    .off('click')
    .on('click', async () => {
      try {
        $('#MANUAL_SERVER_ERROR').addClass('d-none').text('');
        $('#MANUAL_SERVER_PORT').val(DEFAULT_SERVER_PORT);
        RenderManualServerPortHint();
        await window.API.ClearManualServer();
      } catch (error) {
        console.error('Failed to clear manual server:', error);
      }
    });

  $('#BTN_MINIMIZE')
    .off('click')
    .on('click', async () => {
      window.API.Minimise();
    });

  $('#BTN_SHUTDOWN')
    .off('click')
    .on('click', async () => {
      window.API.Shutdown();
    });

  $('#BTN_FACTORY_RESET')
    .off('click')
    .on('click', async () => {
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
