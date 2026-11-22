// Identify overlay renderer. Parses the machine details passed via the window's
// query string, renders them, and closes the overlay (notifying main) on any
// click or when Escape is pressed.
import type { IdentifyOverlayDetails, IdentifyOverlayQuery } from '@showtrak/protocol/client';

/**
 * What the page renders. `Hostname`, `Nickname` and `IPs` come from the JSON
 * `data` param (IdentifyOverlayDetails, written by IdentifyOverlay.Show), any of
 * which may be missing from a URL this page did not get from there; the other
 * two are separate params merged in by parseData.
 */
interface IdentifyOverlayData extends Partial<IdentifyOverlayDetails> {
  ResolutionLabel?: string;
  ScreenNumber?: string;
}

/** The names IdentifyOverlay.Show writes into this page's query string. */
type QueryParam = keyof IdentifyOverlayQuery;

function parseData(): IdentifyOverlayData {
  try {
    const raw = window.location.search.replace(/^\?/, '');
    if (!raw) return {};
    const params = new URLSearchParams(raw);
    // `data` is JSON the main process wrote (IdentifyOverlay.Show), so it is taken
    // as written.
    const data: IdentifyOverlayData =
      (JSON.parse(params.get('data' satisfies QueryParam) || '{}') as IdentifyOverlayData | null) ||
      {};
    const resolutionLabel = params.get('resolutionLabel' satisfies QueryParam);
    const screenNumber = params.get('screenNumber' satisfies QueryParam);
    if (resolutionLabel) data.ResolutionLabel = resolutionLabel;
    if (screenNumber) data.ScreenNumber = screenNumber;
    return data;
  } catch (_err) {
    return {};
  }
}

function render(data: IdentifyOverlayData): void {
  const hostname = data && data.Hostname ? String(data.Hostname) : 'Unknown Host';
  const nickname = data && data.Nickname ? String(data.Nickname) : '';
  const ips = data && Array.isArray(data.IPs) ? data.IPs : [];
  const displayNickname = nickname || hostname;

  const nicknameEl = document.getElementById('nickname');
  const hostnameEl = document.getElementById('hostname');
  const screenNumberEl = document.getElementById('screen-number');
  const resolutionLabelEl = document.getElementById('resolution-label');
  const ipsEl = document.getElementById('ips');
  const ipsEmptyEl = document.getElementById('ips-empty');

  if (screenNumberEl) {
    const numberValue =
      data && data.ScreenNumber != null && String(data.ScreenNumber).trim().length > 0
        ? String(data.ScreenNumber).trim()
        : '';
    screenNumberEl.textContent = numberValue;
    screenNumberEl.style.display = numberValue ? '' : 'none';
    screenNumberEl.classList.toggle('single-digit', numberValue.length === 1);
    screenNumberEl.classList.toggle('digit-one', numberValue === '1');
  }

  if (resolutionLabelEl) {
    resolutionLabelEl.textContent =
      data && data.ResolutionLabel ? String(data.ResolutionLabel) : '';
    resolutionLabelEl.style.display = data && data.ResolutionLabel ? '' : 'none';
  }

  // These four are required by the overlay's markup; bail out rather than
  // half-render if the document ever changes shape.
  if (!nicknameEl || !hostnameEl || !ipsEl || !ipsEmptyEl) return;

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
function close(): void {
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

// Keep this file a module so its declarations stay out of the global scope.
export {};
