/**
 * @fileoverview
 * Handles the main UI logic for the ShowTrak Client application.
 *
 * - Updates the navbar title.
 * - Listens for profile updates and updates the profile display accordingly.
 * - Handles minimize and shutdown button events.
 *
 */
var Profile = {};
var Version = '0.0.0';
var ProcessMonitorStatus = { State: 'unknown', Message: null };
var ServerRecoveryStatus = { State: 'idle', Message: '' };

function RenderProcessMonitorWarning() {
  const $warning = $('#PROCESS_MONITOR_WARNING');
  if (!$warning || !$warning.length) return;
  const state = String(ProcessMonitorStatus && ProcessMonitorStatus.State ? ProcessMonitorStatus.State : 'unknown').toLowerCase();
  const message =
    ProcessMonitorStatus && typeof ProcessMonitorStatus.Message === 'string'
      ? ProcessMonitorStatus.Message.trim()
      : '';
  if (state === 'permission_denied' || state === 'error') {
    $warning
      .removeClass('d-none')
      .text(
        message ||
          'Application monitoring is unavailable. Check system permissions for ShowTrak Client.'
      );
    return;
  }
  $warning.addClass('d-none').text('');
}

function RenderServerRecoveryStatus() {
  const $status = $('#SERVER_RECOVERY_STATUS');
  if (!$status || !$status.length) return;

  const state = String(ServerRecoveryStatus && ServerRecoveryStatus.State ? ServerRecoveryStatus.State : 'idle');
  const normalizedState = state.toLowerCase();
  const message =
    ServerRecoveryStatus && typeof ServerRecoveryStatus.Message === 'string'
      ? ServerRecoveryStatus.Message.trim()
      : '';
  const isConnectedState = !message || normalizedState === 'idle';
  const text = isConnectedState ? 'Connected to ShowTrak Server' : message;

  $status.removeClass('d-none alert-info alert-warning alert-success alert-danger');
  if (normalizedState === 'recoveryfailed') {
    $status.addClass('alert-danger');
  } else if (normalizedState === 'primaryfailed') {
    $status.addClass('alert-warning');
  } else if (normalizedState === 'reconnected' || isConnectedState) {
    $status.addClass('alert-success');
  } else {
    $status.addClass('alert-info');
  }
  $status.text(text);
}

async function Main() {
  await window.API.Loaded();
  Version = await window.API.GetVersion();
  $('#APPLICATION_NAVBAR_TITLE').text(`ShowTrak Client v${Version}`);
  RenderServerRecoveryStatus();
  // Bind updater UI
  $('#BTN_CHECK_UPDATES').off('click').on('click', async () => {
    try { await window.API.CheckForAppUpdates(); } catch {}
    $('#UPDATE_SECTION').removeClass('d-none');
    $('#UPDATE_STATUS').text('Checking for updates...');
    $('#UPDATE_INSTALL_BTN').addClass('d-none');
    $('#UPDATE_LATER_BTN').addClass('d-none');
    $('#UPDATE_NOTES_WRAPPER').addClass('d-none');
    $('#UPDATE_CHANGELOG').empty();
  });
  $('#UPDATE_INSTALL_BTN').off('click').on('click', async () => {
    try { await window.API.InstallAppUpdate(); } catch {}
  });
  $('#UPDATE_LATER_BTN').off('click').on('click', async () => {
    $('#UPDATE_SECTION').addClass('d-none');
  });
  window.API.OnAppUpdateStatus((payload) => {
    try {
      $('#UPDATE_SECTION').removeClass('d-none');
      const st = (payload && payload.state) || 'none';
      const $status = $('#UPDATE_STATUS');
      const $install = $('#UPDATE_INSTALL_BTN');
      const $later = $('#UPDATE_LATER_BTN');
      const $notesWrap = $('#UPDATE_NOTES_WRAPPER');
      const $notes = $('#UPDATE_CHANGELOG');
      $install.addClass('d-none');
      $later.addClass('d-none');
      $notesWrap.addClass('d-none');
      $notes.empty();
      if (st === 'checking') {
        $status.text('Checking for updates...');
      } else if (st === 'available') {
        const v = payload.info && (payload.info.version || payload.info.tag || 'Update available');
        $status.text(`Update available: ${v}. Downloading...`);
      } else if (st === 'downloading') {
        const pct = payload.percent ? Math.floor(payload.percent) : 0;
        $status.text(`Downloading update... ${pct}%`);
      } else if (st === 'downloaded') {
        $status.text('Update downloaded. Restarting to apply...');
      } else if (st === 'installing') {
        $status.text('Installing update...');
      } else if (st === 'installed') {
        $status.text('Update installed. Restarting...');
      } else if (st === 'none') {
        $status.text('No updates available');
      } else if (st === 'error') {
        $status.text(`Update error: ${payload.error || 'Unknown error'}`);
      }
    } catch {}
  });
  window.API.OnProcessMonitorStatus((status) => {
    ProcessMonitorStatus = status || { State: 'unknown', Message: null };
    RenderProcessMonitorWarning();
  });
  window.API.OnServerRecoveryStatus((status) => {
    ServerRecoveryStatus = status || { State: 'idle', Message: '' };
    RenderServerRecoveryStatus();
  });
}
Main();

window.API.SetProfile(async (NewProfile) => {
  Profile = NewProfile;
  Version = await window.API.GetVersion();
  console.log('Profile set:', NewProfile);
  if (Profile.Adopted && Profile.Server) {
    $('#PROFILE').html(`
            <div class="text-center text-white mb-2">
                <span class="badge bg-success">Adopted</span>
            </div>
            <div class="text-center text-white mb-2">
                <span class="badge bg-ghost">${Profile.Server.IP || 'Unknown IP'}</span>
                <span class="badge bg-ghost">${Profile.Server.Port || 'Unknown Port'}</span>
            </div>
            <div class="text-center text-white">
                <span class="badge bg-ghost">${Profile.UUID}</span>
            </div>
        `);
  } else {
    $('#PROFILE').html(`
            <div class="text-center text-white mb-2">
                <span class="badge bg-secondary">Pending Adoption</span>
            </div>
            <div class="text-center text-white mb-2">
                <span class="badge bg-ghost">No Server Set</span>
            </div>
            <div class="text-center text-white">
                <span class="badge bg-ghost">${Profile.UUID}</span>
            </div>
        `);
  }
});

$('#BTN_MINIMIZE').on('click', async () => {
  window.API.Minimise();
});

$('#BTN_SHUTDOWN').on('click', async () => {
  window.API.Shutdown();
});

$('#BTN_FACTORY_RESET').on('click', async () => {
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
