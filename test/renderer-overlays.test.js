const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

const { installDom, clearDom, loadRenderer } = require('./helpers/fake-dom');

// Exercises src/UI/js/app/identify-overlay.ts and launch-countdown.ts, both
// previously 0%.
//
// These are the two windows that appear ON a client machine, full-screen and
// always-on-top, and both are pure side-effect modules — everything runs at
// import, nothing is exported. So they are tested by installing a recording
// DOM, importing the module, and inspecting what it wrote.
//
// What is at stake in each:
//
//   - IDENTIFY is how an operator physically locates a machine in a rack. If it
//     renders the wrong hostname, or renders nothing, they walk to the wrong
//     PC — and the whole point of the feature is to avoid exactly that.
//
//   - LAUNCH COUNTDOWN is the abort window for a run-on-launch script. Its
//     Cancel path is the only thing standing between an unattended boot and a
//     script the operator did not want to run. The authoritative timer lives in
//     the main process (covered in launch-countdown-overlay.test.js); this is
//     the renderer half, and its job is to show the truth and to make cancel
//     reachable by every gesture.

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const IDENTIFY = path.join(APP, 'identify-overlay.js');
const COUNTDOWN = path.join(APP, 'launch-countdown.js');

const IDENTIFY_IDS = [
  'nickname',
  'hostname',
  'screen-number',
  'resolution-label',
  'ips',
  'ips-empty',
];
const COUNTDOWN_IDS = ['script-name', 'countdown', 'cancel'];

test.afterEach(() => {
  mock.timers.reset();
  clearDom();
});

// ===========================================================================
// Identify overlay
// ===========================================================================

/** Boot the identify overlay with a given query string. */
function bootIdentify({ data, resolutionLabel, screenNumber, raw } = {}) {
  const Params = [];
  if (data !== undefined) Params.push(`data=${encodeURIComponent(JSON.stringify(data))}`);
  if (resolutionLabel) Params.push(`resolutionLabel=${encodeURIComponent(resolutionLabel)}`);
  if (screenNumber) Params.push(`screenNumber=${encodeURIComponent(screenNumber)}`);

  const Closed = [];
  const Dom = installDom({
    ids: IDENTIFY_IDS,
    search: raw !== undefined ? raw : `?${Params.join('&')}`,
    api: { IdentifyAPI: { Close: () => Closed.push(Date.now()) } },
  });

  loadRenderer(IDENTIFY);
  return { ...Dom, closed: Closed };
}

test('the identify overlay shows the nickname and hostname when they differ', () => {
  // Both are needed: the nickname is what the operator knows the machine as,
  // the hostname is what they will see on the machine itself.
  const D = bootIdentify({ data: { Hostname: 'foh-01', Nickname: 'FOH PC', IPs: [] } });

  assert.equal(D.el('nickname').textContent, 'FOH PC');
  assert.equal(D.el('hostname').textContent, 'foh-01');
  assert.equal(D.el('hostname').classes().includes('hero'), false);
});

test('with no distinct nickname the hostname becomes the headline', () => {
  // Showing the same string twice, once large and once small, reads as a bug.
  const D = bootIdentify({ data: { Hostname: 'foh-01', IPs: [] } });

  assert.equal(D.el('nickname').textContent, 'foh-01');
  assert.equal(D.el('hostname').style.display, 'none');
  assert.ok(D.el('hostname').classes().includes('hero'));
});

test('a machine with no hostname still identifies itself as something', () => {
  // A blank overlay is useless — the operator cannot tell whether they are
  // looking at the right machine or at a broken window.
  const D = bootIdentify({ data: { IPs: [] } });
  assert.equal(D.el('nickname').textContent, 'Unknown Host');
});

test('every IP is rendered as its own element', () => {
  // A multi-homed show PC is exactly the case where the operator needs to see
  // which network they can reach it on.
  const D = bootIdentify({ data: { Hostname: 'foh-01', IPs: ['10.0.0.5', '192.168.1.5'] } });

  const Ips = D.el('ips');
  assert.equal(Ips.children.length, 2);
  assert.deepEqual(
    Ips.children.map((C) => C.textContent),
    ['10.0.0.5', '192.168.1.5']
  );
  assert.ok(Ips.children.every((C) => C.className === 'ip'));
  assert.equal(D.el('ips-empty').style.display, 'none');
});

test('a machine with no IPs shows the empty state instead of a blank gap', () => {
  const D = bootIdentify({ data: { Hostname: 'foh-01', IPs: [] } });
  assert.equal(D.el('ips').children.length, 0);
  assert.equal(D.el('ips-empty').style.display, '');
});

test('a malformed IP list is treated as empty rather than crashing the render', () => {
  // A crash here leaves an always-on-top window showing nothing, which the
  // operator cannot dismiss by any obvious means.
  for (const IPs of [null, 'nope', 42, {}]) {
    const D = bootIdentify({ data: { Hostname: 'foh-01', IPs } });
    assert.equal(D.el('ips').children.length, 0, `IPs ${JSON.stringify(IPs)}`);
    assert.equal(D.el('ips-empty').style.display, '');
  }
});

test('the screen number is shown, and hidden when there is not one', () => {
  // On a multi-display machine this is how the operator knows WHICH screen they
  // are looking at.
  const Shown = bootIdentify({ data: { Hostname: 'h' }, screenNumber: '2' });
  assert.equal(Shown.el('screen-number').textContent, '2');
  assert.equal(Shown.el('screen-number').style.display, '');

  const Hidden = bootIdentify({ data: { Hostname: 'h' } });
  assert.equal(Hidden.el('screen-number').textContent, '');
  assert.equal(Hidden.el('screen-number').style.display, 'none');
});

test('single-digit screen numbers get their own layout classes', () => {
  // "1" is narrow enough to need kerning of its own; the classes exist so a
  // single digit does not float in the middle of a huge box.
  const One = bootIdentify({ data: { Hostname: 'h' }, screenNumber: '1' });
  assert.ok(One.el('screen-number').classes().includes('single-digit'));
  assert.ok(One.el('screen-number').classes().includes('digit-one'));

  const Two = bootIdentify({ data: { Hostname: 'h' }, screenNumber: '2' });
  assert.ok(Two.el('screen-number').classes().includes('single-digit'));
  assert.ok(!Two.el('screen-number').classes().includes('digit-one'));

  const Ten = bootIdentify({ data: { Hostname: 'h' }, screenNumber: '10' });
  assert.ok(!Ten.el('screen-number').classes().includes('single-digit'));
});

test('the resolution label is shown, and hidden when absent', () => {
  const Shown = bootIdentify({ data: { Hostname: 'h' }, resolutionLabel: '3840x2160' });
  assert.equal(Shown.el('resolution-label').textContent, '3840x2160');
  assert.equal(Shown.el('resolution-label').style.display, '');

  const Hidden = bootIdentify({ data: { Hostname: 'h' } });
  assert.equal(Hidden.el('resolution-label').textContent, '');
  assert.equal(Hidden.el('resolution-label').style.display, 'none');
});

test('a malformed or absent query string still renders something', () => {
  // The overlay is created by the main process, but a truncated or
  // double-encoded URL must not produce a blank always-on-top window.
  for (const Raw of ['', '?', '?data=not-json', '?data=%7Bbroken', '?nothing=here']) {
    const D = bootIdentify({ raw: Raw });
    assert.equal(D.el('nickname').textContent, 'Unknown Host', `search ${JSON.stringify(Raw)}`);
  }
});

test('clicking anywhere closes the overlay', () => {
  // The window covers the whole screen with no chrome, so a click anywhere has
  // to be a way out.
  const D = bootIdentify({ data: { Hostname: 'foh-01' } });
  D.window.fire('click');
  assert.equal(D.closed.length, 1);
});

test('Escape closes the overlay', () => {
  const D = bootIdentify({ data: { Hostname: 'foh-01' } });
  D.window.fire('keydown', { key: 'Escape' });
  assert.equal(D.closed.length, 1);
});

test('other keys do not close the overlay', () => {
  // Identify is often left up while the operator walks to the machine; a stray
  // keypress on the way must not dismiss it.
  const D = bootIdentify({ data: { Hostname: 'foh-01' } });
  for (const Key of ['a', 'Enter', 'Shift', ' ', 'ArrowLeft']) {
    D.window.fire('keydown', { key: Key });
  }
  assert.equal(D.closed.length, 0);
});

test('close is idempotent however many gestures arrive', () => {
  // A click and an Escape in quick succession must not send two Close calls to
  // a window the main process has already torn down.
  const D = bootIdentify({ data: { Hostname: 'foh-01' } });
  D.window.fire('keydown', { key: 'Escape' });
  D.window.fire('keydown', { key: 'Escape' });
  D.window.fire('click');
  assert.equal(D.closed.length, 1);
});

test('a missing bridge does not leave an uncloseable window throwing', () => {
  // If the preload failed, the overlay cannot notify main — but it must not
  // throw on every keypress either. Main tears the window down regardless.
  const Dom = installDom({ ids: IDENTIFY_IDS, search: '?data=%7B%7D', api: {} });
  loadRenderer(IDENTIFY);
  assert.doesNotThrow(() => Dom.window.fire('click'));
  assert.doesNotThrow(() => Dom.window.fire('keydown', { key: 'Escape' }));
});

// ===========================================================================
// Launch countdown
// ===========================================================================

/** Boot the countdown overlay with a given query string. */
function bootCountdown({ script, seconds, raw } = {}) {
  const Params = [];
  if (script !== undefined) Params.push(`script=${encodeURIComponent(script)}`);
  if (seconds !== undefined) Params.push(`seconds=${encodeURIComponent(seconds)}`);

  const Cancels = [];
  const Dom = installDom({
    ids: COUNTDOWN_IDS,
    search: raw !== undefined ? raw : `?${Params.join('&')}`,
    api: { LaunchCountdownAPI: { Cancel: () => Cancels.push(Date.now()) } },
  });

  loadRenderer(COUNTDOWN);
  return { ...Dom, cancels: Cancels };
}

test('the countdown names the script that is about to run', () => {
  // The operator has seconds to decide whether to abort. Not saying WHAT is
  // about to run makes that decision impossible.
  const D = bootCountdown({ script: 'Reset Projectors', seconds: 30 });
  assert.equal(D.el('script-name').textContent, 'Reset Projectors');
  assert.equal(D.el('countdown').textContent, '30');
});

test('an unnamed script still gets a label rather than a blank', () => {
  const D = bootCountdown({ seconds: 10 });
  assert.equal(D.el('script-name').textContent, 'startup script');
});

test('an unusable countdown falls back to ten seconds, never to zero', () => {
  // A zero-second window is no abort window at all — the script would run
  // before the operator could read the name.
  for (const Seconds of ['0', '-5', 'soon', '']) {
    const D = bootCountdown({ script: 's', seconds: Seconds });
    assert.equal(D.el('countdown').textContent, '10', `seconds ${JSON.stringify(Seconds)}`);
  }

  const Missing = bootCountdown({ script: 's' });
  assert.equal(Missing.el('countdown').textContent, '10');
});

test('the countdown ticks down once a second', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const D = bootCountdown({ script: 's', seconds: 3 });

  assert.equal(D.el('countdown').textContent, '3');
  mock.timers.tick(1000);
  assert.equal(D.el('countdown').textContent, '2');
  mock.timers.tick(1000);
  assert.equal(D.el('countdown').textContent, '1');
});

test('the countdown stops at zero rather than going negative', () => {
  // The main process owns the real expiry; a renderer showing "-4" makes the
  // window look broken at the exact moment it matters.
  mock.timers.enable({ apis: ['setInterval'] });
  const D = bootCountdown({ script: 's', seconds: 2 });

  mock.timers.tick(10_000);
  assert.equal(D.el('countdown').textContent, '0');
});

test('the Cancel button aborts the script', () => {
  const D = bootCountdown({ script: 's', seconds: 30 });
  D.el('cancel').fire('click');
  assert.equal(D.cancels.length, 1);
});

test('Escape and Shift both abort', () => {
  // Shift is deliberate: it is the key an operator can hit without looking, and
  // it mirrors the main process's own before-input-event fallback.
  for (const Key of ['Escape', 'Shift']) {
    const D = bootCountdown({ script: 's', seconds: 30 });
    D.window.fire('keydown', { key: Key });
    assert.equal(D.cancels.length, 1, `key ${Key}`);
  }
});

test('other keys do not abort', () => {
  const D = bootCountdown({ script: 's', seconds: 30 });
  for (const Key of ['a', 'Enter', ' ', 'Control', 'ArrowDown']) {
    D.window.fire('keydown', { key: Key });
  }
  assert.equal(D.cancels.length, 0);
});

test('cancelling stops the ticker, so the display freezes where it was', () => {
  // A countdown that keeps running after the operator aborted suggests the
  // abort did not take.
  mock.timers.enable({ apis: ['setInterval'] });
  const D = bootCountdown({ script: 's', seconds: 30 });

  mock.timers.tick(1000);
  assert.equal(D.el('countdown').textContent, '29');

  D.el('cancel').fire('click');
  mock.timers.tick(10_000);
  assert.equal(D.el('countdown').textContent, '29', 'the ticker outlived the cancel');
});

test('cancel is sent exactly once however many gestures arrive', () => {
  // The button, Escape and Shift are all reachable in the same second; sending
  // three cancels to main for one abort is noise at best.
  const D = bootCountdown({ script: 's', seconds: 30 });

  D.el('cancel').fire('click');
  D.window.fire('keydown', { key: 'Escape' });
  D.window.fire('keydown', { key: 'Shift' });
  D.el('cancel').fire('click');

  assert.equal(D.cancels.length, 1);
});

test('a missing bridge does not throw out of the abort path', () => {
  // If the preload failed, the button is dead — but the main process also
  // watches for Esc/Shift at the window level, and that fallback only works if
  // the renderer has not thrown first.
  const Dom = installDom({ ids: COUNTDOWN_IDS, search: '?script=s&seconds=30', api: {} });
  loadRenderer(COUNTDOWN);

  assert.doesNotThrow(() => Dom.el('cancel').fire('click'));
  assert.doesNotThrow(() => Dom.window.fire('keydown', { key: 'Escape' }));
});

test('a malformed query string still produces a usable countdown', () => {
  for (const Raw of ['', '?', '?seconds=&script=', '?nothing=here']) {
    const D = bootCountdown({ raw: Raw });
    assert.equal(
      D.el('script-name').textContent,
      'startup script',
      `search ${JSON.stringify(Raw)}`
    );
    assert.equal(D.el('countdown').textContent, '10');
  }
});
