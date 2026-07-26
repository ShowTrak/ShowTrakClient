// Post-download integrity verification in ScriptManager.DownloadScripts.
//
// Everything written under the scripts directory is later handed to spawn(), so
// the bytes that arrive over the wire are the bytes that get executed. The
// manifest checksum used to be consulted only to decide whether a file ALREADY
// on disk was stale — the downloaded response itself was never compared to
// anything, so a truncated transfer or a response from the wrong server was
// written and run as-is.
//
// These tests pin the three outcomes: a matching checksum writes, a mismatched
// one refuses and leaves nothing behind, and a manifest entry with no published
// checksum still deploys (the Server writes null when it could not hash a file,
// and failing those would turn a Server-side read error into a client that
// cannot deploy at all).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');

const DOWNLOAD_BODY = '#!/bin/sh\necho deployed';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Load ScriptManager with a fetch that always serves DOWNLOAD_BODY and a
// checksum helper whose buffer digest is scripted by the caller.
function loadScriptManager({ scriptsDir, profileDir, bufferChecksum }) {
  return loadWithMocks(MODULE_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '@showtrak/protocol/runtime': {
      // Only consulted for files already on disk; every case here downloads
      // into an empty directory, so it never decides the outcome.
      ChecksumFile: async () => 'stale',
      ChecksumBuffer: () => bufferChecksum,
    },
    '../Broadcast': { Manager: { emit: () => {}, on: () => {} } },
  });
}

// `Buffer.from(str).buffer` hands back Node's shared 64KB allocation pool, not
// the string's bytes — a real fetch() returns an exactly-sized ArrayBuffer, so
// the slice below is what keeps this stub faithful to what the code under test
// actually receives (and what lets the content assertion below mean anything).
function exactArrayBuffer(text) {
  const Bytes = Buffer.from(text);
  return Bytes.buffer.slice(Bytes.byteOffset, Bytes.byteOffset + Bytes.byteLength);
}

function withStubbedFetch(run) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => exactArrayBuffer(DOWNLOAD_BODY),
  });
  return (async () => {
    try {
      return await run();
    } finally {
      global.fetch = originalFetch;
    }
  })();
}

function scriptWithChecksum(Checksum) {
  return [
    {
      ID: 'integrity-script',
      Name: 'Integrity Script',
      Enabled: true,
      Platforms: { macOS: 'macos.sh' },
      Arguments: { macOS: '' },
      Files: [{ Path: 'macos.sh', Type: 'file', Checksum }],
    },
  ];
}

test('a download whose checksum matches the manifest is written', async () => {
  const scriptsDir = tempDir('showtrak-integrity-ok-s-');
  const target = path.join(scriptsDir, 'integrity-script', 'macos.sh');

  await withStubbedFetch(async () => {
    const { Manager } = loadScriptManager({
      scriptsDir,
      profileDir: tempDir('showtrak-integrity-ok-p-'),
      bufferChecksum: 'matching-sum',
    });

    await Manager.DownloadScripts('127.0.0.1', 8080, scriptWithChecksum('matching-sum'));
  });

  assert.equal(fs.existsSync(target), true, 'a verified download must be written to disk');
  assert.equal(fs.readFileSync(target, 'utf8'), DOWNLOAD_BODY);
});

test('a download whose checksum does not match the manifest is refused and not written', async () => {
  const scriptsDir = tempDir('showtrak-integrity-bad-s-');
  const target = path.join(scriptsDir, 'integrity-script', 'macos.sh');

  await withStubbedFetch(async () => {
    const { Manager } = loadScriptManager({
      scriptsDir,
      profileDir: tempDir('showtrak-integrity-bad-p-'),
      // What actually arrived is not what the manifest promised.
      bufferChecksum: 'what-actually-arrived',
    });

    await assert.rejects(
      () => Manager.DownloadScripts('127.0.0.1', 8080, scriptWithChecksum('what-was-promised')),
      /checksum mismatch/,
      'a mismatch must surface as a deployment failure, not pass silently'
    );
  });

  assert.equal(
    fs.existsSync(target),
    false,
    'unverified bytes must never reach a path that is later handed to spawn()'
  );
});

test('a manifest entry with no published checksum still deploys', async () => {
  const scriptsDir = tempDir('showtrak-integrity-null-s-');
  const target = path.join(scriptsDir, 'integrity-script', 'macos.sh');

  await withStubbedFetch(async () => {
    const { Manager } = loadScriptManager({
      scriptsDir,
      profileDir: tempDir('showtrak-integrity-null-p-'),
      bufferChecksum: 'anything',
    });

    await Manager.DownloadScripts('127.0.0.1', 8080, scriptWithChecksum(null));
  });

  assert.equal(
    fs.existsSync(target),
    true,
    'a Server that could not hash a file must not block deployment entirely'
  );
});
