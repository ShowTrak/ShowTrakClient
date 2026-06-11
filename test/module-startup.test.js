const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

test('Startup manager enables autostart when packaged and disabled', async () => {
  const autoLaunchCalls = [];

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Startup', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    electron: {
      app: { isPackaged: true },
    },
    'auto-launch': function AutoLaunch(options) {
      autoLaunchCalls.push(options);
      return {
        isEnabled: async () => false,
        enable: async () => {
          autoLaunchCalls.push('enable');
        },
      };
    },
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {} }),
    },
    '../Config': {
      Config: {
        Application: {
          Name: 'ShowTrak Client',
        },
      },
    },
  });

  const result = await Manager.EnsureEnabled();

  assert.equal(result, true);
  assert.equal(autoLaunchCalls.length, 2);
  assert.deepEqual(autoLaunchCalls[0], {
    name: 'ShowTrak Client',
    path: process.execPath,
    isHidden: true,
  });
  assert.equal(autoLaunchCalls[1], 'enable');
});

test('Startup manager skips autostart while unpackaged', async () => {
  let constructed = false;

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Startup', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    electron: {
      app: { isPackaged: false },
    },
    'auto-launch': function AutoLaunch() {
      constructed = true;
      return {
        isEnabled: async () => true,
        enable: async () => {},
      };
    },
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {} }),
    },
    '../Config': {
      Config: {
        Application: {
          Name: 'ShowTrak Client',
        },
      },
    },
  });

  const result = await Manager.EnsureEnabled();

  assert.equal(result, false);
  assert.equal(constructed, false);
});

test('Startup manager leaves an existing autostart entry alone', async () => {
  let enableCalls = 0;

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Startup', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    electron: {
      app: { isPackaged: true },
    },
    'auto-launch': function AutoLaunch() {
      return {
        isEnabled: async () => true,
        enable: async () => {
          enableCalls += 1;
        },
      };
    },
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {} }),
    },
    '../Config': {
      Config: {
        Application: {
          Name: 'ShowTrak Client',
        },
      },
    },
  });

  const result = await Manager.EnsureEnabled();

  assert.equal(result, true);
  assert.equal(enableCalls, 0);
});