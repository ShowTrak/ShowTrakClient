const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// StorageMonitor: mounted volumes, reported as `StorageVolumes`.
//
// The parsers are tested against the text each platform really prints (the
// macOS fixtures are a real machine's output); the monitor itself against a
// scripted sampler, so the reporting rules — first report always, then only on
// a change or the keepalive, free space compared in steps — are pinned down
// independently of the machine running the suite.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'StorageMonitor');
const loggerStub = { CreateLogger: () => createSilentLogger() };
const GB = 1024 ** 3;

const load = (file, mocks = {}) =>
  loadWithMocks(path.join(DIST, file), { '../Logger': loggerStub, ...mocks });

// ---------------------------------------------------------------------------
// df
// ---------------------------------------------------------------------------

const MAC_DF = [
  'Filesystem     1024-blocks       Used Available Capacity  Mounted on',
  '/dev/disk3s1s1  1948455240   12343216 193563092     6%    /',
  'devfs                  361        361         0   100%    /dev',
  '/dev/disk3s6    1948455240    1048780 193563092     1%    /System/Volumes/VM',
  '/dev/disk3s5    1948455240 1731153528 193563092    90%    /System/Volumes/Data',
  'map auto_home            0          0         0   100%    /System/Volumes/Data/home',
  '/dev/disk7s1      17659904   17159516    455144    98%    /Library/Developer/CoreSimulator/Volumes/iOS_23F77',
  '/dev/disk4s2     976762584  512000000 464762584    53%    /Volumes/Show Media',
  '//tk@nas._smb._tcp.local/Show  976762584  512000000 464762584    53%    /Volumes/Show',
].join('\n');

test('df: every line is read from its numbers outwards, so spaces in names survive', () => {
  const { ParseDfOutput } = load('df.js');
  const Rows = ParseDfOutput(MAC_DF);
  assert.equal(Rows.length, 8);
  assert.deepEqual(Rows[0], {
    Device: '/dev/disk3s1s1',
    MountPoint: '/',
    TotalBytes: 1948455240 * 1024,
    FreeBytes: 193563092 * 1024,
  });
  assert.equal(Rows[4].Device, 'map auto_home');
  assert.equal(Rows[6].MountPoint, '/Volumes/Show Media');
  assert.equal(Rows[7].Device, '//tk@nas._smb._tcp.local/Show');
});

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

const MAC_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  '/dev/disk7s1 on /Library/Developer/CoreSimulator/Volumes/iOS_23F77 (apfs, sealed, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)',
  '/dev/disk4s2 on /Volumes/Show Media (exfat, local, nodev, nosuid, read-only, noowners)',
  '//tk@nas._smb._tcp.local/Show on /Volumes/Show (smbfs, nodev, nosuid, mounted by tk)',
].join('\n');

const PLIST = (Name, Internal, Smart) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>Internal</key>
	<${Internal ? 'true' : 'false'}/>
	<key>SMARTStatus</key>
	<string>${Smart}</string>
	<key>VolumeName</key>
	<string>${Name}</string>
</dict>
</plist>`;

test('mount: filesystem and flags per mount point', () => {
  const { ParseMacMountOutput } = load('macos.js');
  const Mounts = ParseMacMountOutput(MAC_MOUNT);
  assert.equal(Mounts.length, 8);
  assert.deepEqual(Mounts[3], {
    Device: '/dev/disk3s5',
    MountPoint: '/System/Volumes/Data',
    FileSystem: 'apfs',
    Flags: ['local', 'journaled', 'nobrowse', 'protect', 'root data'],
  });
  assert.equal(Mounts[6].MountPoint, '/Volumes/Show Media');
});

test('diskutil: name, internal, and a SMART verdict only where the disk gives one', () => {
  const { ParseDiskutilInfo } = load('macos.js');
  assert.deepEqual(ParseDiskutilInfo(PLIST('Macintosh HD', true, 'Verified')), {
    Name: 'Macintosh HD',
    Internal: true,
    Health: 'ok',
  });
  assert.equal(ParseDiskutilInfo(PLIST('Stick', false, 'Not Supported')).Health, null);
  assert.equal(ParseDiskutilInfo(PLIST('Old', true, 'Failing')).Health, 'failing');
  assert.equal(ParseDiskutilInfo(PLIST('R&amp;D', true, 'Verified')).Name, 'R&D');
  assert.deepEqual(ParseDiskutilInfo(''), { Name: null, Internal: null, Health: null });
});

test('macOS volumes: the boot disk and what Finder shows; "/" is as writable as its Data volume', () => {
  const { BuildMacVolumes, ParseMacMountOutput } = load('macos.js');
  const { ParseDfOutput } = load('df.js');
  const Info = new Map([
    ['/dev/disk3s1s1', { Name: 'Macintosh HD', Internal: true, Health: 'ok' }],
    ['/dev/disk4s2', { Name: 'SHOW MEDIA', Internal: false, Health: null }],
  ]);
  const Volumes = BuildMacVolumes(ParseDfOutput(MAC_DF), ParseMacMountOutput(MAC_MOUNT), Info);
  assert.deepEqual(
    Volumes.map((Volume) => Volume.MountPoint),
    ['/', '/Volumes/Show Media', '/Volumes/Show']
  );
  const [Boot, Card, Share] = Volumes;
  assert.deepEqual(Boot, {
    MountPoint: '/',
    Name: 'Macintosh HD',
    FileSystem: 'apfs',
    Kind: 'internal',
    TotalBytes: 1948455240 * 1024,
    FreeBytes: 193563092 * 1024,
    ReadOnly: false,
    Health: 'ok',
  });
  assert.equal(Card.Kind, 'external');
  assert.equal(Card.ReadOnly, true);
  assert.equal(Card.Name, 'SHOW MEDIA');
  assert.equal(Share.Kind, 'network');
  assert.equal(Share.Name, 'Show');
  assert.equal(Share.Health, null);
});

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

const PROC_MOUNTS = [
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  '/dev/mapper/vg-root / ext4 rw,relatime 0 0',
  'tmpfs /run tmpfs rw,nosuid,nodev 0 0',
  '/dev/loop3 /snap/core22/1380 squashfs ro,nodev,relatime 0 0',
  '/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0',
  '/dev/mapper/vg-root /var/lib/docker/overlay2 ext4 rw,relatime 0 0',
  '/dev/sdb1 /run/media/show/SHOW\\040MEDIA exfat ro,nosuid,nodev 0 0',
  '//nas/show /mnt/show cifs rw,relatime,vers=3.1.1 0 0',
  '/dev/mapper/vg-root /home ext4 rw,relatime 0 0',
].join('\n');

test('/proc/mounts: unescaped, and narrowed to real disks and shares, one per device', () => {
  const { ParseProcMounts, SelectLinuxMounts } = load('linux.js');
  const Selected = SelectLinuxMounts(ParseProcMounts(PROC_MOUNTS));
  assert.deepEqual(
    Selected.map((Mount) => Mount.MountPoint),
    ['/', '/boot/efi', '/run/media/show/SHOW MEDIA', '/mnt/show']
  );
  assert.deepEqual(Selected[2].Options, ['ro', 'nosuid', 'nodev']);
});

function fakeReader() {
  const Links = {
    '/dev/disk/by-label/SHOW\\x20MEDIA': '/dev/sdb1',
    '/dev/disk/by-label/root': '/dev/dm-0',
    '/dev/mapper/vg-root': '/dev/dm-0',
    '/dev/sdb1': '/dev/sdb1',
    '/dev/nvme0n1p1': '/dev/nvme0n1p1',
    '/sys/class/block/sdb1':
      '/sys/devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host0/target0:0:0/0:0:0:0/block/sdb/sdb1',
    '/sys/class/block/dm-0': '/sys/devices/virtual/block/dm-0',
    '/sys/class/block/nvme0n1p1':
      '/sys/devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1/nvme0n1p1',
  };
  const Files = {
    '/sys/devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1/nvme0n1p1/partition': '1\n',
    '/sys/devices/pci0000:00/0000:00:1d.0/nvme/nvme0/nvme0n1/removable': '0\n',
    '/sys/devices/virtual/block/dm-0/removable': '0\n',
    '/proc/mounts': PROC_MOUNTS,
  };
  return {
    ReadDir: (Directory) => (Directory === '/dev/disk/by-label' ? ['SHOW\\x20MEDIA', 'root'] : []),
    ReadFile: (File) => (File in Files ? Files[File] : null),
    RealPath: (Target) => Links[Target] || null,
  };
}

test('Linux volumes: labels from by-label, USB disks external, read-only from the options', () => {
  const {
    ParseProcMounts,
    SelectLinuxMounts,
    BuildLinuxVolumes,
    ReadLinuxLabels,
    LinuxDeviceKind,
  } = load('linux.js');
  const Reader = fakeReader();
  const Df = [
    { Device: '/dev/mapper/vg-root', MountPoint: '/', TotalBytes: 500 * GB, FreeBytes: 100 * GB },
    { Device: '/dev/nvme0n1p1', MountPoint: '/boot/efi', TotalBytes: 1 * GB, FreeBytes: 0.9 * GB },
    {
      Device: '/dev/sdb1',
      MountPoint: '/run/media/show/SHOW MEDIA',
      TotalBytes: 64 * GB,
      FreeBytes: 10 * GB,
    },
    { Device: '//nas/show', MountPoint: '/mnt/show', TotalBytes: 4096 * GB, FreeBytes: 1024 * GB },
  ];
  const Volumes = BuildLinuxVolumes(
    SelectLinuxMounts(ParseProcMounts(PROC_MOUNTS)),
    Df,
    ReadLinuxLabels(Reader),
    (Device) => LinuxDeviceKind(Device, Reader),
    (Device) => Reader.RealPath(Device)
  );
  assert.deepEqual(
    Volumes.map((Volume) => [Volume.MountPoint, Volume.Name, Volume.Kind, Volume.ReadOnly]),
    [
      ['/', 'root', 'internal', false],
      ['/boot/efi', null, 'internal', false],
      ['/run/media/show/SHOW MEDIA', 'SHOW MEDIA', 'external', true],
      ['/mnt/show', '//nas/show', 'network', false],
    ]
  );
  assert.ok(
    Volumes.every((Volume) => Volume.Health === null),
    'SMART needs root'
  );
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

test('Windows: drive letters with health and read-only where the Storage module says', () => {
  const { ParseWindowsStorage } = load('windows.js', {
    '../ProcessMonitor/powershell-host': {
      CreatePowerShellHost: () => ({ Run: async () => [null, ''], Dispose() {} }),
    },
  });
  const Output = JSON.stringify([
    {
      Drive: 'C:',
      Label: 'Windows',
      FileSystem: 'NTFS',
      Size: 500 * GB,
      Free: 120 * GB,
      Type: 3,
      Provider: null,
      Health: 'Healthy',
      ReadOnly: false,
    },
    {
      Drive: 'e:',
      Label: '',
      FileSystem: 'exFAT',
      Size: 64 * GB,
      Free: 70 * GB,
      Type: 2,
      Provider: null,
      Health: 'Warning',
      ReadOnly: true,
    },
    {
      Drive: 'S:',
      Label: null,
      FileSystem: 'NTFS',
      Size: 4096 * GB,
      Free: 1024 * GB,
      Type: 4,
      Provider: '\\\\nas\\show',
      Health: null,
      ReadOnly: null,
    },
    { Drive: 'F:', Label: null, FileSystem: null, Size: null, Free: null, Type: 2 },
  ]);
  const Volumes = ParseWindowsStorage(`WARNING: noise\r\n${Output}\r\n`);
  assert.deepEqual(
    Volumes.map((Volume) => [
      Volume.MountPoint,
      Volume.Name,
      Volume.Kind,
      Volume.ReadOnly,
      Volume.Health,
    ]),
    [
      ['C:', 'Windows', 'internal', false, 'ok'],
      ['E:', null, 'external', true, 'warning'],
      ['S:', '\\\\nas\\show', 'network', null, null],
    ]
  );
  assert.equal(Volumes[1].FreeBytes, Volumes[1].TotalBytes, 'free never exceeds the size');
  // One drive arrives as a bare object rather than a one-element array.
  assert.equal(
    ParseWindowsStorage(JSON.stringify({ Drive: 'C:', Size: 10, Free: 5, Type: 3 })).length,
    1
  );
  assert.deepEqual(ParseWindowsStorage(''), []);
  assert.throws(() => ParseWindowsStorage('nothing useful'));
});

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

test('the boot volume sorts first, then by mount point', () => {
  const { SortVolumes } = load('samplers.js', {
    './macos': {},
    './linux': {},
    './windows': { DisposeWindowsStorage() {} },
  });
  const Sorted = SortVolumes(
    [{ MountPoint: 'E:' }, { MountPoint: 'C:' }, { MountPoint: 'D:' }],
    'c:'
  ).map((Volume) => Volume.MountPoint);
  assert.deepEqual(Sorted, ['C:', 'D:', 'E:']);
  assert.deepEqual(
    SortVolumes([
      { MountPoint: '/Volumes/B' },
      { MountPoint: '/' },
      { MountPoint: '/Volumes/A' },
    ]).map((Volume) => Volume.MountPoint),
    ['/', '/Volumes/A', '/Volumes/B']
  );
});

function reading(FreeBytes = 400 * GB, Extra = {}) {
  return {
    Ok: true,
    Reading: {
      Backend: 'df+diskutil',
      Volumes: [
        {
          MountPoint: '/',
          Name: 'Macintosh HD',
          FileSystem: 'apfs',
          Kind: 'internal',
          TotalBytes: 1000 * GB,
          FreeBytes,
          ReadOnly: false,
          Health: 'ok',
          ...Extra,
        },
      ],
    },
  };
}

function loadMonitor() {
  const state = { next: reading(), disposals: 0 };
  const intervals = [];
  const timeouts = [];
  const original = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  global.setInterval = (callback, ms) => {
    const handle = { callback, ms, unref() {} };
    intervals.push(handle);
    return handle;
  };
  global.clearInterval = (handle) => {
    const index = intervals.indexOf(handle);
    if (index !== -1) intervals.splice(index, 1);
  };
  const mod = load('index.js', {
    './samplers': {
      CollectStorage: async () => state.next,
      DisposeStorageSamplers: () => {
        state.disposals += 1;
      },
    },
  });
  return {
    ...mod,
    state,
    intervals,
    timeouts,
    restore: () => Object.assign(global, original),
  };
}

function fakeSocket() {
  const emits = [];
  return { connected: true, emits, emit: (event, payload) => emits.push([event, payload]) };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('BuildSnapshot: ok carries the volumes; a failure says why, and lists none', () => {
  const { BuildSnapshot, restore } = loadMonitor();
  try {
    const Ok = BuildSnapshot(reading(), 'darwin', 5);
    assert.deepEqual(Ok.Status, {
      State: 'ok',
      Message: null,
      Platform: 'darwin',
      Backend: 'df+diskutil',
    });
    assert.equal(Ok.Volumes.length, 1);
    const Failed = BuildSnapshot(
      { Ok: false, Unsupported: false, Error: new Error('df hung') },
      'linux',
      5
    );
    assert.deepEqual(Failed, {
      SampledAt: 5,
      Status: { State: 'error', Message: 'df hung', Platform: 'linux', Backend: null },
      Volumes: [],
    });
    assert.equal(
      BuildSnapshot({ Ok: false, Unsupported: true, Error: new Error('no') }, 'aix', 5).Status
        .State,
      'unsupported'
    );
  } finally {
    restore();
  }
});

test('free space is compared in steps: a byte is not a change, a gigabyte is', () => {
  const { BuildSnapshot, SnapshotSignature, restore } = loadMonitor();
  try {
    const at = (Free, Extra) => SnapshotSignature(BuildSnapshot(reading(Free, Extra), 'darwin', 1));
    assert.equal(at(400 * GB + 10), at(400 * GB + 1000));
    assert.notEqual(at(400 * GB), at(398 * GB));
    assert.notEqual(at(400 * GB), at(400 * GB, { ReadOnly: true }), 'going read-only is a change');
  } finally {
    restore();
  }
});

test('reports on start, then only on change or keepalive; stops cleanly', async () => {
  const H = loadMonitor();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const socket = fakeSocket();
    await H.Manager.Start(socket);
    assert.equal(socket.emits.length, 1);
    assert.equal(socket.emits[0][0], 'StorageVolumes');
    assert.equal(H.intervals[0].ms, 20000);

    now += 20_000;
    H.intervals[0].callback();
    await flush();
    assert.equal(socket.emits.length, 1, 'nothing changed');

    H.state.next = reading(300 * GB);
    now += 20_000;
    H.intervals[0].callback();
    await flush();
    assert.equal(socket.emits.length, 2);
    assert.equal(socket.emits[1][1].Volumes[0].FreeBytes, 300 * GB);

    now += 60_000;
    H.intervals[0].callback();
    await flush();
    assert.equal(socket.emits.length, 3, 'keepalive');

    H.Manager.Stop();
    assert.equal(H.intervals.length, 0);
    assert.equal(H.state.disposals, 1);
  } finally {
    Date.now = realNow;
    H.restore();
  }
});
