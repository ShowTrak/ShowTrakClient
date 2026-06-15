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
  const message =
    ServerRecoveryStatus && typeof ServerRecoveryStatus.Message === 'string'
      ? ServerRecoveryStatus.Message.trim()
      : '';

  if (!message || state === 'idle') {
    $status.addClass('d-none').text('');
    return;
  }

  $status.removeClass('d-none alert-info alert-warning alert-success alert-danger');
  if (state === 'RecoveryFailed') {
    $status.addClass('alert-danger');
  } else if (state === 'Reconnected') {
    $status.addClass('alert-success');
  } else if (state === 'PrimaryFailed') {
    $status.addClass('alert-warning');
  } else {
    $status.addClass('alert-info');
  }
  $status.text(message);
}

async function Main() {
  await window.API.Loaded();
  Version = await window.API.GetVersion();
  $('#APPLICATION_NAVBAR_TITLE').text(`ShowTrak Client v${Version}`);
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
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const sanitizeHref = (href) => {
    try { const h = String(href || '').trim(); if (/^(https?:|mailto:)/i.test(h)) return h; } catch {}
    return '#';
  };
  const renderMarkdownSafe = (md) => {
    if (!md || typeof md !== 'string') return '';
    let text = md.replace(/\r\n/g, '\n');
    text = escapeHtml(text);
    const codeBlocks = [];
    text = text.replace(/```([\s\S]*?)```/g, (_m, code) => { const idx = codeBlocks.push(code) - 1; return `%%CODEBLOCK_${idx}%%`; });
    text = text.replace(/^#{1,6}\s+(.+)$/gm, (m) => { const hashes = m.match(/^#+/)[0].length; const content = m.replace(/^#{1,6}\s+/, ''); const level = Math.min(6, Math.max(1, hashes)); return `<h${level} class="h${level+2}">${content}</h${level}>`; });
    text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
    text = text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (_m, label, href) => { const url = sanitizeHref(href); return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`; });
    text = text.replace(/(?:^|\n)((?:[\-\*\+]\s+.*(?:\n|$))+)/g, (_m, block) => { const items = block.trim().split(/\n/).map((line) => line.replace(/^[\-\*\+]\s+/, '').trim()).filter((x) => x.length > 0).map((x) => `<li>${x}</li>`).join(''); return `\n<ul>${items}</ul>`; });
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
               .replace(/__(.+?)__/g, '<strong>$1</strong>')
               .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>')
               .replace(/_(?!\s)(.+?)(?<!\s)_/g, '<em>$1</em>');
    const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    const html = blocks.map((b) => { if (/^<\/?(h\d|ul|ol|li|pre|blockquote|table|p|code)/i.test(b)) return b; return `<p>${b.replace(/\n/g, '<br/>')}</p>`; }).join('\n');
    return html.replace(/%%CODEBLOCK_(\d+)%%/g, (_m, i) => { const code = codeBlocks[Number(i)] || ''; return `<pre class="mb-2"><code>${code}</code></pre>`; });
  };
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
      const extractNotes = (info) => {
        if (!info) return '';
        const raw = info.releaseNotes || info.notes || info.body || '';
        if (Array.isArray(raw)) {
          const first = raw.find(Boolean);
          return (first && (first.releaseNotes || first.notes || first.body)) || '';
        }
        return raw || '';
      };
      const showNotes = (info) => {
        const notes = extractNotes(info);
        if (notes && typeof notes === 'string') {
          const looksHtml = /<\w+[^>]*>/.test(notes);
          if (looksHtml) { $notes.html(notes); } else { $notes.html(renderMarkdownSafe(notes)); }
          $notesWrap.removeClass('d-none');
        }
      };
      if (st === 'checking') {
        $status.text('Checking for updates...');
      } else if (st === 'available') {
        const v = payload.info && (payload.info.version || payload.info.tag || 'Update available');
        $status.text(`Update available: ${v}. Downloading...`);
        showNotes(payload.info);
      } else if (st === 'downloading') {
        const pct = payload.percent ? Math.floor(payload.percent) : 0;
        $status.text(`Downloading update... ${pct}%`);
      } else if (st === 'downloaded') {
        const v = payload.info && (payload.info.version || 'pending');
        $status.text(`Update ready to install: ${v}`);
        showNotes(payload.info);
        $install.removeClass('d-none');
        $later.removeClass('d-none');
      } else if (st === 'installing') {
        $status.text('Installing update...');
      } else if (st === 'installed') {
        $status.text('Update installed. Restarting...');
      } else if (st === 'none') {
        $status.text('No updates available');
      } else if (st === 'error') {
        $status.text(`Update error: ${payload.error || 'Unknown error'}`);
        $later.removeClass('d-none');
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
