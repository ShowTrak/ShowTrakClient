const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/UI/js/app/lib/status-models.ts — the status derivations for the
// client config window, extracted from main.ts (which was 0%).
//
// This window is frequently the only thing a venue tech looks at on a client
// PC. Every rule here answers "is this machine actually doing its job", and
// every one of them fails silently: a green badge over a dead socket, or a
// hidden permission warning, makes a broken client look healthy.

const MODELS_PATH = path.join(
  __dirname,
  '..',
  'dist-test',
  'UI',
  'js',
  'app',
  'lib',
  'status-models.js'
);

const {
  GetAdoptionBadgeModel,
  GetServerRecoveryBannerModel,
  GetProcessMonitorWarningModel,
  GetAppUpdateStatusText,
  GetManualServerModel,
  DEFAULT_SERVER_PORT,
} = require(MODELS_PATH);

const adopted = (O = {}) => ({ Adopted: true, Server: { IP: '10.0.0.10', Port: 3000 }, ...O });
const recovery = (State, Message = '') => ({ State, Message });

// --- Adoption badge ---------------------------------------------------------

test('an unadopted client reads as pending, whatever the recovery status says', () => {
  // A client with no server cannot be connected to one. A stale recovery status
  // must never be able to paint "Adopted, Connected" over an unadopted machine.
  for (const Profile of [
    null,
    undefined,
    {},
    { Adopted: false },
    { Adopted: true },
    { Server: { IP: '10.0.0.10' } },
  ]) {
    const Model = GetAdoptionBadgeModel(Profile, recovery('reconnected', 'Recovered'));
    assert.equal(Model.label, 'Pending Adoption', `profile ${JSON.stringify(Profile)}`);
    assert.equal(Model.className, 'bg-primary');
  }
});

test('an adopted client with a healthy connection reads as connected', () => {
  for (const Recovery of [null, undefined, recovery('idle'), recovery('idle', '  ')]) {
    const Model = GetAdoptionBadgeModel(adopted(), Recovery);
    assert.equal(Model.label, 'Adopted, Connected', `recovery ${JSON.stringify(Recovery)}`);
    assert.equal(Model.className, 'bg-success');
  }
});

test('a client mid-recovery reads as disconnected, in red', () => {
  // The case that matters: the operator must be able to tell across a room that
  // this machine has lost its server.
  for (const State of ['primaryfailed', 'discovering', 'validatingidentity', 'recoveryfailed']) {
    const Model = GetAdoptionBadgeModel(adopted(), recovery(State, 'Searching for server'));
    assert.equal(Model.label, 'Adopted, Disconnected', `state ${State}`);
    assert.equal(Model.className, 'bg-danger');
  }
});

test('a completed recovery reads as connected again', () => {
  const Model = GetAdoptionBadgeModel(adopted(), recovery('reconnected', 'Recovered connection'));
  assert.equal(Model.label, 'Adopted, Connected');
});

test('state matching is case-insensitive', () => {
  // Recovery states are pushed as PascalCase on the wire ('PrimaryFailed').
  assert.equal(
    GetAdoptionBadgeModel(adopted(), recovery('Reconnected', 'Recovered')).label,
    'Adopted, Connected'
  );
  assert.equal(
    GetAdoptionBadgeModel(adopted(), recovery('PrimaryFailed', 'Unreachable')).label,
    'Adopted, Disconnected'
  );
});

test('a state with no message never reads as disconnected', () => {
  // A bare state with nothing to say is not evidence of a fault, and showing red
  // with an empty banner would leave the operator with nothing to act on.
  assert.equal(
    GetAdoptionBadgeModel(adopted(), recovery('primaryfailed', '')).label,
    'Adopted, Connected'
  );
});

test('a non-string recovery message does not throw', () => {
  for (const Message of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => GetAdoptionBadgeModel(adopted(), { State: 'x', Message }));
  }
});

// --- Recovery banner --------------------------------------------------------

test('a healthy client shows a reassuring green banner', () => {
  for (const Recovery of [null, undefined, recovery('idle'), recovery('idle', 'ignored')]) {
    const Model = GetServerRecoveryBannerModel(Recovery);
    assert.equal(
      Model.text,
      'Connected to ShowTrak Server',
      `recovery ${JSON.stringify(Recovery)}`
    );
    assert.equal(Model.className, 'alert-success');
  }
});

test('each recovery state gets the severity colour it deserves', () => {
  assert.equal(
    GetServerRecoveryBannerModel(recovery('recoveryfailed', 'Gave up')).className,
    'alert-danger'
  );
  assert.equal(
    GetServerRecoveryBannerModel(recovery('primaryfailed', 'Unreachable')).className,
    'alert-warning'
  );
  assert.equal(
    GetServerRecoveryBannerModel(recovery('reconnected', 'Recovered')).className,
    'alert-success'
  );
  assert.equal(
    GetServerRecoveryBannerModel(recovery('discovering', 'Searching')).className,
    'alert-info'
  );
});

test('the banner shows the message the badge hides', () => {
  // Deliberate asymmetry with the badge: 'reconnected' counts as connected for
  // the badge, but the banner still reports what happened, so a recovery does
  // not silently vanish before anyone notices it occurred.
  const Recovery = recovery('reconnected', 'Recovered connection to 10.0.0.9:3000');
  assert.equal(GetAdoptionBadgeModel(adopted(), Recovery).label, 'Adopted, Connected');
  assert.equal(
    GetServerRecoveryBannerModel(Recovery).text,
    'Recovered connection to 10.0.0.9:3000'
  );
});

test('the banner and the badge never disagree about being disconnected', () => {
  // A green badge over a red banner is worse than either alone — it tells the
  // operator the screen is lying and they cannot trust any of it.
  for (const State of ['primaryfailed', 'discovering', 'recoveryfailed', 'validatingidentity']) {
    const Recovery = recovery(State, 'Something is wrong');
    const Badge = GetAdoptionBadgeModel(adopted(), Recovery);
    const Banner = GetServerRecoveryBannerModel(Recovery);

    assert.equal(Badge.className, 'bg-danger', `state ${State}`);
    assert.notEqual(Banner.className, 'alert-success', `state ${State} showed a green banner`);
  }
});

test('a whitespace-only message is treated as no message', () => {
  const Model = GetServerRecoveryBannerModel(recovery('primaryfailed', '   '));
  assert.equal(Model.text, 'Connected to ShowTrak Server');
});

// --- Application monitoring warning ----------------------------------------

test('a permission failure is surfaced with actionable text', () => {
  // On macOS this needs an explicit grant. Without the warning the client
  // reports an empty application list forever while looking healthy, so every
  // critical-application alert silently stops working.
  const Model = GetProcessMonitorWarningModel({ State: 'permission_denied', Message: null });
  assert.equal(Model.visible, true);
  assert.match(Model.text, /permissions/i);
  assert.match(Model.text, /ShowTrak Client/);
});

test('a specific failure message is preferred over the generic one', () => {
  const Model = GetProcessMonitorWarningModel({
    State: 'error',
    Message: 'ps command not found',
  });
  assert.equal(Model.visible, true);
  assert.equal(Model.text, 'ps command not found');
});

test('the warning is hidden for every state the operator cannot act on', () => {
  // 'unknown' before the first sample, and 'ok' when it is working. Showing a
  // warning for either would train the operator to ignore it.
  for (const State of ['ok', 'unknown', '', null, undefined, 'something-new']) {
    const Model = GetProcessMonitorWarningModel({ State, Message: 'ignored' });
    assert.equal(Model.visible, false, `state ${JSON.stringify(State)}`);
    assert.equal(Model.text, '');
  }
  assert.equal(GetProcessMonitorWarningModel(null).visible, false);
});

test('warning state matching is case-insensitive', () => {
  assert.equal(GetProcessMonitorWarningModel({ State: 'PERMISSION_DENIED' }).visible, true);
  assert.equal(GetProcessMonitorWarningModel({ State: 'Error' }).visible, true);
});

test('a whitespace-only message falls back to the generic text', () => {
  const Model = GetProcessMonitorWarningModel({ State: 'error', Message: '   ' });
  assert.match(Model.text, /permissions/i);
});

// --- App update status ------------------------------------------------------

test('every update state produces a distinct status line', () => {
  const Cases = [
    [{ state: 'checking' }, /Checking for updates/],
    [{ state: 'available', info: { version: '3.14.0' } }, /Update available: 3\.14\.0/],
    [{ state: 'downloading', percent: 42.9 }, /Downloading update\.\.\. 42%/],
    [{ state: 'downloaded' }, /Restarting to apply/],
    [{ state: 'installing' }, /Installing update/],
    [{ state: 'installed' }, /Restarting/],
    [{ state: 'none' }, /No updates available/],
    [{ state: 'error', error: 'signature mismatch' }, /Update error: signature mismatch/],
  ];

  const Seen = new Set();
  for (const [Payload, Pattern] of Cases) {
    const Text = GetAppUpdateStatusText(Payload);
    assert.match(Text, Pattern, `state ${Payload.state}`);
    assert.ok(!Seen.has(Text), `state ${Payload.state} duplicates another status line`);
    Seen.add(Text);
  }
});

test('an available update falls back through version, tag, then a generic label', () => {
  assert.match(
    GetAppUpdateStatusText({ state: 'available', info: { version: '3.14.0' } }),
    /3\.14\.0/
  );
  assert.match(
    GetAppUpdateStatusText({ state: 'available', info: { tag: 'v3.14.0' } }),
    /v3\.14\.0/
  );
  assert.match(GetAppUpdateStatusText({ state: 'available', info: {} }), /Update available/);
  assert.match(GetAppUpdateStatusText({ state: 'available' }), /Update available/);
});

test('download progress is floored to a whole percent and never NaN', () => {
  assert.match(GetAppUpdateStatusText({ state: 'downloading' }), /0%/);
  assert.match(GetAppUpdateStatusText({ state: 'downloading', percent: 99.99 }), /99%/);
  assert.match(GetAppUpdateStatusText({ state: 'downloading', percent: null }), /0%/);
});

test('an update error always names something', () => {
  assert.match(GetAppUpdateStatusText({ state: 'error' }), /Unknown error/);
  assert.match(GetAppUpdateStatusText({ state: 'error', error: '' }), /Unknown error/);
});

test('a payload with no state is treated as "no updates"', () => {
  assert.equal(GetAppUpdateStatusText({}), 'No updates available');
});

test('an unusable payload leaves the panel alone rather than clearing it', () => {
  // Null means "do not touch": a malformed push must not wipe a message the
  // operator is part-way through reading.
  for (const Payload of [null, undefined, 'nope', 42]) {
    assert.equal(GetAppUpdateStatusText(Payload), null, `payload ${JSON.stringify(Payload)}`);
  }
  assert.equal(GetAppUpdateStatusText({ state: 'a-state-from-the-future' }), null);
});

test('an array payload reads as "no updates" — behaviour preserved from main.ts', () => {
  // `typeof [] === 'object'`, so an array passes the guard and its absent
  // `state` falls through to 'none'. Carried over deliberately rather than
  // tightened during the extraction: the payload comes from a main-process IPC
  // push that always sends an object, so this is not reachable, and changing it
  // would have made the extraction a behaviour change rather than a move.
  assert.equal(GetAppUpdateStatusText([]), 'No updates available');
});

// --- Manual server ----------------------------------------------------------

test('a configured manual endpoint is shown as such', () => {
  // This is the only way a client on a routed or VLAN network reaches its
  // server, since mDNS cannot cross the boundary — so it must be unambiguous.
  const Model = GetManualServerModel({ ManualServer: { Host: '192.168.9.5', Port: 4000 } });
  assert.equal(Model.isManual, true);
  assert.equal(Model.host, '192.168.9.5');
  assert.equal(Model.port, 4000);
  assert.equal(Model.statusText, 'Manual');
  assert.equal(Model.addClass, 'bg-success');
});

test('a manual endpoint with no port falls back to the default', () => {
  for (const Port of [null, undefined, 0, '', 'nope']) {
    const Model = GetManualServerModel({ ManualServer: { Host: '192.168.9.5', Port } });
    assert.equal(Model.port, DEFAULT_SERVER_PORT, `port ${JSON.stringify(Port)}`);
  }
});

test('no manual endpoint reads as Not Set, with empty fields', () => {
  for (const Profile of [
    null,
    undefined,
    {},
    { ManualServer: null },
    { ManualServer: {} },
    { ManualServer: { Host: '' } },
    { ManualServer: { Port: 4000 } },
  ]) {
    const Model = GetManualServerModel(Profile);
    assert.equal(Model.isManual, false, `profile ${JSON.stringify(Profile)}`);
    assert.equal(Model.statusText, 'Not Set');
    assert.equal(Model.host, '');
    assert.equal(Model.port, DEFAULT_SERVER_PORT);
    assert.equal(Model.addClass, 'bg-secondary');
  }
});

test('a port-only manual entry never reads as configured', () => {
  // A host is what makes an endpoint reachable; a port alone is a half-filled
  // form, and showing it as Manual would suggest the client is pinned somewhere
  // it is not.
  const Model = GetManualServerModel({ ManualServer: { Port: 4000 } });
  assert.equal(Model.isManual, false);
  assert.equal(Model.port, DEFAULT_SERVER_PORT, 'the orphan port must not be presented as live');
});

test('the classes added and removed are always opposites', () => {
  // main.ts applies both; if they ever matched, the badge would keep a stale
  // colour from the previous render.
  for (const Profile of [{ ManualServer: { Host: 'h' } }, {}]) {
    const Model = GetManualServerModel(Profile);
    assert.notEqual(Model.addClass, Model.removeClass);
  }
});
