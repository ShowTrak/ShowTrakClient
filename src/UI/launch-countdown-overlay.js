// Launch countdown overlay renderer. Displays the pending run-on-launch script
// name and a ticking countdown, and asks main to cancel on any abort gesture
// (Cancel button, Esc, Shift). The authoritative expiry timer lives in the main
// process; this countdown is purely visual.
(function () {
  'use strict';

  function parseParams() {
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

  var config = parseParams();

  var scriptEl = document.getElementById('script-name');
  var countdownEl = document.getElementById('countdown');
  var cancelBtn = document.getElementById('cancel');

  if (scriptEl) scriptEl.textContent = config.script;

  var remaining = config.seconds;
  function paint() {
    if (countdownEl) countdownEl.textContent = String(Math.max(0, remaining));
  }
  paint();

  var ticker = setInterval(function () {
    remaining -= 1;
    if (remaining <= 0) {
      remaining = 0;
      clearInterval(ticker);
    }
    paint();
  }, 1000);

  var cancelled = false;
  function cancel() {
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
})();
