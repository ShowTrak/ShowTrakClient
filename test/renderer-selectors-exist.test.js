// Every element ID the renderer paints must exist in the HTML it paints into.
//
// The renderer is deliberately untested against a DOM (no jsdom), so a selector
// that matches nothing fails silently: jQuery returns an empty set and every
// .text()/.addClass() call on it is a no-op. The panel simply stays blank, which
// on a client PC reads as "the client is not working" with no error anywhere.
//
// This became a live risk when the profile panel moved from being assembled with
// .html() to being painted by ID against static markup — the IDs are now a
// contract between two files that nothing else checks.
//
// Static analysis, so it holds without a browser: extract $('#ID') selectors from
// the renderer sources and assert each ID appears as an id="..." in the matching
// HTML entry point.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const UI_DIR = path.join(__dirname, '..', 'src', 'UI');

/** Renderer entry point -> the HTML document it is loaded into. */
const ENTRY_POINTS = [
  { script: path.join(UI_DIR, 'js', 'app', 'main.ts'), html: path.join(UI_DIR, 'index.html') },
  {
    script: path.join(UI_DIR, 'js', 'app', 'identify-overlay.ts'),
    html: path.join(UI_DIR, 'identify-overlay.html'),
  },
  {
    script: path.join(UI_DIR, 'js', 'app', 'launch-countdown.ts'),
    html: path.join(UI_DIR, 'launch-countdown-overlay.html'),
  },
];

/** IDs referenced as $('#FOO') or $("#FOO"), and via getElementById('FOO'). */
function extractReferencedIds(source) {
  const ids = new Set();
  const jqueryIdSelector = /\$\(\s*(['"`])#([A-Za-z0-9_-]+)\1\s*\)/g;
  const getElementById = /getElementById\(\s*(['"`])([A-Za-z0-9_-]+)\1\s*\)/g;
  for (const re of [jqueryIdSelector, getElementById]) {
    let match;
    while ((match = re.exec(source)) !== null) ids.add(match[2]);
  }
  return ids;
}

function extractDeclaredIds(html) {
  const ids = new Set();
  const re = /\sid=(['"])([A-Za-z0-9_-]+)\1/g;
  let match;
  while ((match = re.exec(html)) !== null) ids.add(match[2]);
  return ids;
}

for (const { script, html } of ENTRY_POINTS) {
  const scriptName = path.basename(script);
  const htmlName = path.basename(html);

  test(`${scriptName} only targets IDs that exist in ${htmlName}`, () => {
    const referenced = extractReferencedIds(fs.readFileSync(script, 'utf8'));
    const declared = extractDeclaredIds(fs.readFileSync(html, 'utf8'));

    assert.ok(referenced.size > 0, `expected ${scriptName} to reference at least one element ID`);

    const missing = [...referenced].filter((id) => !declared.has(id)).sort();
    assert.deepEqual(
      missing,
      [],
      `${scriptName} paints IDs that ${htmlName} does not declare: ${missing.join(', ')}`
    );
  });
}

test('the profile panel declares every ID ApplyProfile paints', () => {
  // Spelled out explicitly as well as covered by the sweep above, because these
  // five are the ones that replaced the old .html() interpolation. If one is
  // renamed in only one of the two files, the panel silently stops updating.
  const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  const declared = extractDeclaredIds(html);
  for (const id of [
    'PROFILE',
    'PROFILE_ADOPTION_BADGE',
    'PROFILE_SERVER_IP',
    'PROFILE_SERVER_PORT',
    'PROFILE_SERVER_NONE',
    'PROFILE_UUID',
  ]) {
    assert.ok(declared.has(id), `index.html is missing #${id}`);
  }
});

test('the profile panel is no longer built by interpolating into .html()', () => {
  // Guards the actual fix: the UUID and endpoint come from a server payload, and
  // building markup out of them made this an injection sink in a
  // context-isolated window.
  const source = fs.readFileSync(path.join(UI_DIR, 'js', 'app', 'main.ts'), 'utf8');
  assert.equal(
    /\$\(\s*['"]#PROFILE['"]\s*\)\s*\.html\(/.test(source),
    false,
    '#PROFILE must be painted with .text(), not assembled with .html()'
  );
  assert.equal(
    /\.html\(\s*`/.test(source),
    false,
    'no template literal may be passed to .html() in the renderer'
  );
});
