// Identify overlay renderer. Parses the machine details passed via the window's
// query string, renders them, and closes the overlay (notifying main) on any
// click or when Escape is pressed.
(function () {
  'use strict';

  function parseData() {
    try {
      const raw = window.location.search.replace(/^\?/, '');
      if (!raw) return {};
      const params = new URLSearchParams(raw);
      const data = JSON.parse(params.get('data') || '{}') || {};
      const resolutionLabel = params.get('resolutionLabel');
      if (resolutionLabel) data.ResolutionLabel = resolutionLabel;
      return data;
    } catch (_err) {
      return {};
    }
  }

  function render(data) {
    const hostname = data && data.Hostname ? String(data.Hostname) : 'Unknown Host';
    const nickname = data && data.Nickname ? String(data.Nickname) : '';
    const ips = Array.isArray(data && data.IPs) ? data.IPs : [];
    const displayNickname = nickname || hostname;

    const nicknameEl = document.getElementById('nickname');
    const hostnameEl = document.getElementById('hostname');
    const resolutionLabelEl = document.getElementById('resolution-label');
    const ipsEl = document.getElementById('ips');
    const ipsEmptyEl = document.getElementById('ips-empty');

    if (resolutionLabelEl) {
      resolutionLabelEl.textContent =
        data && data.ResolutionLabel ? String(data.ResolutionLabel) : '';
      resolutionLabelEl.style.display = data && data.ResolutionLabel ? '' : 'none';
    }

    if (displayNickname !== hostname) {
      nicknameEl.textContent = displayNickname;
      nicknameEl.style.display = '';
      hostnameEl.textContent = hostname;
      hostnameEl.classList.remove('hero');
    } else {
      // No distinct nickname: show the hostname as the client name.
      nicknameEl.textContent = hostname;
      nicknameEl.style.display = '';
      hostnameEl.style.display = 'none';
      hostnameEl.textContent = hostname;
      hostnameEl.classList.add('hero');
    }

    ipsEl.textContent = '';
    if (ips.length) {
      for (const ip of ips) {
        const span = document.createElement('span');
        span.className = 'ip';
        span.textContent = String(ip);
        ipsEl.appendChild(span);
      }
      ipsEmptyEl.style.display = 'none';
    } else {
      ipsEmptyEl.style.display = '';
    }
  }

  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    try {
      if (window.IdentifyAPI && typeof window.IdentifyAPI.Close === 'function') {
        window.IdentifyAPI.Close();
      }
    } catch (_err) {
      // Main will also tear the window down; nothing else to do here.
    }
  }

  render(parseData());

  window.addEventListener('click', close, { once: true });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });
})();
