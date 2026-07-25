// Launch countdown overlay renderer. Displays the pending run-on-launch script
// name and a ticking countdown, and asks main to cancel on any abort gesture
// (Cancel button, Esc, Shift). The authoritative expiry timer lives in the main
// process; this countdown is purely visual.
interface CountdownConfig {
  script: string;
  seconds: number;
}

function parseParams(): CountdownConfig {
  try {
    const params = new URLSearchParams(window.location.search.replace(/^\?/, ''));
    const seconds = parseInt(params.get('seconds') || '0', 10);
    return {
      script: params.get('script') || 'startup script',
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 10,
    };
  } catch (_err) {
    return { script: 'startup script', seconds: 10 };
  }
}

const config = parseParams();

const scriptEl = document.getElementById('script-name');
const countdownEl = document.getElementById('countdown');
const cancelBtn = document.getElementById('cancel');

if (scriptEl) scriptEl.textContent = config.script;

let remaining = config.seconds;
function paint(): void {
  if (countdownEl) countdownEl.textContent = String(Math.max(0, remaining));
}
paint();

const ticker = setInterval(function () {
  remaining -= 1;
  if (remaining <= 0) {
    remaining = 0;
    clearInterval(ticker);
  }
  paint();
}, 1000);

let cancelled = false;
function cancel(): void {
  if (cancelled) return;
  cancelled = true;
  clearInterval(ticker);
  try {
    if (window.LaunchCountdownAPI && typeof window.LaunchCountdownAPI.Cancel === 'function') {
      window.LaunchCountdownAPI.Cancel();
    }
  } catch (_err) {
    // Main also has a keyboard fallback; nothing else to do here.
  }
}

if (cancelBtn) cancelBtn.addEventListener('click', cancel);
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' || e.key === 'Shift') cancel();
});

// Keep this file a module so its declarations stay out of the global scope.
export {};
