# ShowTrak Client — Refactor & Tech-Debt Plan

Audit date: 2026-07-26. Baseline: `v3.14.0`, `main` clean, CI green
(lint / format / typecheck / 319 tests all pass), coverage 78.12% statements /
75.52% branches.

The tree is in good shape on the dimensions CI can see. Everything below is debt
CI cannot see: a monolithic main process, a server-trusting filesystem write
path, an Electron runtime six majors behind, and several structural patterns the
Server repo already solved and the Client never adopted.

Fixed constraints carried over from earlier decisions — these are **not** revisited
by this plan:

- jQuery stays in the renderer. No framework migration.
- No jsdom. Renderer testing is extract-pure only (the `lib/status-models.ts`
  precedent).
- No CI coverage gate.

---

## Status — all work packages closed 2026-07-26

Everything below was implemented on `refactor/tech-debt-2026-07`. Baseline moved
from 334 tests / 78.6% statements to **411 tests / 84.6% statements**, with lint,
format, typecheck and a 32-check Electron API probe green throughout.

| WP  | Outcome                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | **Done.** Path traversal closed; verified exploitable before the fix.                                                                       |
| 1b  | **Done.** Uptime no longer wraps at 24h.                                                                                                    |
| 1c  | **Done.** 7 shadowed `catch (Error)` renamed + lint guard added.                                                                            |
| 1e  | **Done.** Safe-mode comment corrected.                                                                                                      |
| 1d  | **Partly done.** The real bug (concatenated `HOME` → literal `undefined/…`) is fixed. The macOS directory move is **deferred** — see below. |
| 2a  | **Done.** 4 unused deps removed (11 packages), safe minor/patch batch taken.                                                                |
| 2b  | **Done.** Electron 37.2.2 → 43.2.0.                                                                                                         |
| 2c  | **Partly done.** ESLint 10 taken. `usb` 3.x and `@electron/fuses` 2.x **held back** — see below.                                            |
| 3   | **Done.** main.ts 1,652 → 160 lines across 13 modules.                                                                                      |
| 3b  | **Done.** 46 cases on the newly-reachable modules.                                                                                          |
| 4   | **Mostly done.** Quality pass complete; the `bonjour-service` swap **deferred** — see below.                                                |
| 5   | **Done.** `ReadIdentityToken` + `ErrorMessage` extracted.                                                                                   |
| 6   | **Done.** Profile panel painted with `.text()`; selector-existence test added.                                                              |
| 7   | **Done.** Husky hook made real, dependabot added, non-gating coverage step.                                                                 |
| 8   | **Done.** Log identity, adoption spelling, stray `console.log`s.                                                                            |

### Three items deliberately left open

Each needs something this environment could not provide. They are not oversights.

**1. `usb` 2.18 → 3.x.** Not a version bump but a napi-rs rewrite: `getDevices()`
returns node-usb's `UsbDevice` rather than a WebUSB `USBDevice`, `open()`/`close()`
became async, `bus` changed from number to string. All five fields USBMonitor reads
do still exist on the new type, so it is probably fine — but this machine has zero
accessible USB devices, so end-to-end device reporting could not be verified, and
the failure mode is silent (devices reported with null names). **Needs: a run on
hardware with real USB devices attached.**

**2. `@electron/fuses` 1.8 → 2.x.** The six `FuseV1Options` this app sets are
byte-identical in 2.x and `forge.config.js` loads fine, but
`@electron-forge/plugin-fuses@7.11.2` (latest) declares `@electron/fuses: ^1.0.0`,
so 2.x leaves an invalid peer dependency and `npm ls` exits non-zero. **Needs:
electron-forge to widen its peer range.**

**3. `bonjour` → `bonjour-service`.** The quality problems in the Bonjour module
(42 silent catches, triplicated teardown) are fixed. The library swap is not: the
existing tests mock the `bonjour` package itself, so replacing it means rewriting
those mocks, and the suite would then verify new code against new mocks rather
than against real mDNS behaviour. **Needs: a real multi-NIC LAN with a live
ShowTrak server to validate against.**

**Also open: moving the macOS state directory to `Application Support`.** Blocked
on a constraint the original plan missed — `AppData` is imported by `Logger`, and
`Logger` documents that it avoids an `electron` dependency so it stays loadable
outside an Electron main process (the whole test suite relies on this), which rules
out `app.getPath('userData')`. `getPath('userData')` also resolves to `…/Electron`
unpackaged. And every macOS client in the field has its `Profile.json` in the
current location, so relocating without a migration makes it forget its identity
and re-adopt. **Needs: a decision about fleets in service, plus a migration.**

### Still needing a human on real hardware

The Electron 43 jump is verified by 411 tests and a 32-check API probe
(`npm run probe:electron`), but the probe deliberately does not boot `dist/main.js`
— that would touch the real profile and advertise the machine for adoption on the
LAN. Not yet exercised: **tray behaviour on Windows**, and the **Squirrel and
electron-updater install-and-restart paths**, which need a signed packaged build.

---

## Original plan

The analysis below is kept as the record of what was found and why each change was
made. Line numbers refer to the pre-refactor tree.

## Priority summary

| WP  | Title                                     | Size | Risk of not doing it                             |
| --- | ----------------------------------------- | ---- | ------------------------------------------------ |
| 1   | Security & correctness fixes              | M    | Arbitrary file write from a server; wrong vitals |
| 2   | Electron 37 → 43 + dependency sweep       | M    | ~6 majors of unpatched Chromium CVEs             |
| 3   | Decompose `src/main.ts` (1649 lines)      | L    | Untestable, unreviewable main process            |
| 4   | Rewrite the Bonjour module                | M    | Unmaintained dep; 42 silent catches              |
| 5   | Extract cross-cutting duplication         | M    | Same bug must be fixed in 5–10 places            |
| 6   | Renderer `UI/js/app/main.ts` (0% covered) | S    | Untested UI + `.html()` interpolation            |
| 7   | Tooling parity with the Server            | S    | Husky installed but inert; no dependabot         |
| 8   | Naming & typo cleanup                     | S    | Misspelled public API surface                    |

Recommended order: 1 → 2 → 7 → 3 → 5 → 4 → 6 → 8. WP-1 and WP-2 first because
they are user-facing risk; WP-7 early because it is ~10 minutes and stops
regressions; WP-3 before WP-5 because the extractions in 5 land naturally into
the modules 3 creates.

---

## WP-1 — Security & correctness fixes

### 1a. Path traversal in script deployment (**highest severity**)

[ScriptManager/index.ts:649](src/Modules/ScriptManager/index.ts#L649) and
[:660](src/Modules/ScriptManager/index.ts#L660) join server-supplied strings
straight onto the scripts directory:

```ts
const ScriptPath = path.join(ScriptsDirectory, Script.ID);
const FilePath = path.join(ScriptPath, Path);
```

Both `Script.ID` and `File.Path` arrive from the server over the wire. Verified:
`path.join('/Scripts/ScriptA', '../../../../tmp/evil.sh')` → `/tmp/evil.sh`.
The write at [:697](src/Modules/ScriptManager/index.ts#L697) then lands there,
and `Internal.RunScriptFile` will `chmod 0755` and execute anything under a
resolved script path.

The client does pin `ServerIdentity`, so this is not an unauthenticated hole —
but "the server we adopted to can overwrite any file this user can write, then
get it executed" is a much larger blast radius than script deployment needs, and
the LAN transport is plain `http://`.

Fix: add a containment helper and apply it to every derived path.

```ts
function ResolveContained(Base: string, ...Segments: string[]): string | null {
  const Resolved = path.resolve(Base, ...Segments);
  const Root = path.resolve(Base) + path.sep;
  return Resolved.startsWith(Root) ? Resolved : null;
}
```

Reject (and push to `Failures`) any `Script.ID` or `File.Path` that fails
containment, plus any absolute path or empty segment. Apply in `DownloadScripts`,
`GetScriptLaunchState`, and `DeleteScripts`. Add tests for `../`, an absolute
path, a UNC path, and a backslash variant (`Path.replaceAll('\\','/')` at
[:686](src/Modules/ScriptManager/index.ts#L686) means Windows separators reach
`path.join` too).

### 1b. Uptime wraps silently at 24 hours

[OS/index.ts:92](src/Modules/OS/index.ts#L92):

```ts
Formatted: new Date(Uptime * 1000).toISOString().substr(11, 8),
```

Verified: a machine up 25h 1m 30s reports `01:01:30`. For an installation whose
whole purpose is monitoring long-lived arcade/show machines, "uptime" being
mod-24h is a real reporting defect, and it is invisible — the value looks
plausible. `substr` is also deprecated.

Fix: format from the raw seconds (`Math.floor(u/3600)` with no modulo on hours),
allowing the hours field to exceed 2 digits. Unit-test 0s, 59s, 24h exactly,
25h, and 100h+.

### 1c. `catch (Error)` shadows the global `Error` constructor

7 occurrences: [main.ts:432](src/main.ts#L432),
[:1006](src/main.ts#L1006), [:1602](src/main.ts#L1602),
[ProfileManager:63](src/Modules/ProfileManager/index.ts#L63),
[:76](src/Modules/ProfileManager/index.ts#L76),
[:220](src/Modules/ProfileManager/index.ts#L220),
[HardwareIdentity:85](src/Modules/HardwareIdentity/index.ts#L85).

No current bug — none of those blocks construct an error — but any future
`throw new Error(...)` inside one of them fails at runtime in a way that reads as
impossible. Rename to `Err` (the codebase's existing convention) and add
`no-shadow-restricted-names` plus an ESLint `id-denylist`-style guard, or simply
lint for it via `@typescript-eslint/no-shadow`.

### 1d. AppData base path is hand-rolled and non-conventional

[AppData/index.ts:4-9](src/Modules/AppData/index.ts#L4-L9):

```ts
const BasePath =
  process.env.APPDATA ||
  (process.platform == 'darwin'
    ? process.env.HOME + '/Library/Preferences'
    : process.env.HOME + '/.local/share');
```

Three problems: `~/Library/Preferences` is the wrong macOS location (Apple
reserves it for `defaults`/plists; app data belongs in `Application Support` —
which is where the **Server** puts its own data); `process.env.HOME +` yields the
literal string `"undefined/.local/share"` when `HOME` is unset (a service account
or a bare systemd unit); and it diverges from `app.getPath('userData')` for no
stated reason.

Fix: use `app.getPath('userData')` with the current logic retained **only** as a
fallback for non-Electron test contexts, and add a one-shot migration that moves
an existing `~/Library/Preferences/ShowTrakClient` into the new location on first
run. The migration matters — without it, a macOS client silently forgets its
`Profile.json` and re-adopts. Ship 1d in its own release with the migration
covered by tests.

### 1e. Contradictory safe-mode comment

[main.ts:605-607](src/main.ts#L605-L607) documents "Absence-of-file sentinel to
disable ALL launch actions" but the code enables safe mode on the file's
**presence**. Fix the comment.

---

## WP-2 — Electron 37 → 43 and dependency sweep

`electron` is pinned exactly at `37.2.2`; latest is `43.2.0`. The Server is
already on `^43.2.0`, so the two apps ship different Chromium runtimes. Six
majors of Chromium is the single largest untreated security exposure in the repo,
and the divergence also means a renderer quirk fixed on the Server can still bite
here.

Also outdated / dead:

| Package                | Current | Latest | Action                                                                                              |
| ---------------------- | ------- | ------ | --------------------------------------------------------------------------------------------------- |
| `electron`             | 37.2.2  | 43.2.0 | Upgrade; match the Server's `^43.2.0`                                                               |
| `@electron/fuses`      | 1.8.0   | 2.1.3  | Major; re-verify `forge.config.js` fuse names                                                       |
| `usb`                  | 2.15.0  | 3.0.1  | Major; native addon — rebuild + retest USB events on all 3 OSes                                     |
| `node-os-utils`        | 1.3.7   | —      | **0 references. Remove** (with `@types/node-os-utils`)                                              |
| `update-electron-app`  | 3.1.1   | —      | **0 references. Remove** — `electron-updater` is the live path                                      |
| `eslint` / `@eslint/*` | 9.x/0.x | 10.x   | Majors; do as one batch after the Electron work settles                                             |
| `typescript`           | ~5.7    | 7.0.2  | Defer — track the Server, migrate both together                                                     |
| minor/patch drift      | —       | —      | `socket.io-client`, `electron-updater`, `prettier`, `macaddress`, `bonjour`, `globals` — safe batch |

Removing the two dead dependencies also trims the asar, which is a tracked
concern for this app.

Sequence: (i) minor/patch batch, confirm CI; (ii) Electron 37→43 alone, then
manually verify tray behaviour on macOS + Windows, the identify overlay,
the launch countdown, and the Squirrel/electron-updater install paths — these are
the areas Electron majors actually break, and none are covered by `node --test`;
(iii) `usb` and `@electron/fuses` majors; (iv) ESLint 10.

Do **not** bundle these into one PR. An Electron major regression that surfaces
only on a venue PC needs to be bisectable.

---

## WP-3 — Decompose `src/main.ts`

1649 lines — the largest hand-written file in either app, and 5× the Server's
`main.ts` (340 lines). It currently holds: tray construction and image
resolution, window creation and security guards, 11 IPC handlers, the entire
dual-path auto-updater (Squirrel **and** electron-updater, ~400 lines), the
recovery state machine, Bonjour discovery orchestration, and the run-on-launch
flow. Coverage reflects it: **51.12% statements, 50% functions** — by far the
worst-covered file in the repo, and it is the file that decides whether an
unattended client ever reconnects.

The Server already solved this exact problem and the convention is sitting right
there in `ShowTrakServer/src/main/` (17 files, none over 640 lines, most under
120). Mirror it rather than inventing a new layout:

| New file                       | Moved from `main.ts`                                                                                                            | ~Lines |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/main/tray.ts`             | `getTrayImage`, `buildTrayScriptMenuItems`, `buildTrayContextMenuTemplate`, `refreshTrayContextMenu`                            | 150    |
| `src/main/app-window.ts`       | `createMainWindow`, `openConfigureWindow`, `hasMainWindow`, `getWindowIconPath`                                                 | 110    |
| `src/main/window-guards.ts`    | `applyWindowSecurityGuards`                                                                                                     | 30     |
| `src/main/renderer-bus.ts`     | every `mainWindow && !mainWindow.isDestroyed() && send(...)` (10 sites)                                                         | 40     |
| `src/main/rpc.ts`              | `assertNoArgs`, `validationErrorPayload`, a `handle()` wrapper                                                                  | 40     |
| `src/main/ipc-handlers.ts`     | the 11 `RPC.handle` registrations                                                                                               | 180    |
| `src/main/app-updater.ts`      | Squirrel + electron-updater, `performUpdateCheck`, `mapUpdaterStateToProgress`, `requestQuitAndInstall`, the remote-LAN session | 480    |
| `src/main/recovery.ts`         | the recovery state machine, metrics, backoff, `waitForRecoveryValidation`                                                       | 260    |
| `src/main/discovery.ts`        | `discoverSingleServer`, `extractServerIdentityToken`                                                                            | 90     |
| `src/main/launch-actions.ts`   | `RunLaunchActions`, `IsSafeModeEnabled`                                                                                         | 80     |
| `src/main/broadcast-bridge.ts` | the 10 `BroadcastManager.on(...)` registrations                                                                                 | 130    |
| `src/main.ts` (remaining)      | single-instance lock, `whenReady`, `Main()`, `BootWithStoredSettings`, wiring                                                   | ~150   |

Two constraints that make this safe to do mechanically:

1. **Module-level mutable state is the hard part.** `mainWindow`, `tray`,
   `recoveryMetrics`, `recoveryInProgress`, `pendingRecoveryCandidate`,
   `currentRecoveryStatus`, `currentAppUpdateStatus`, `autoInstallNext`,
   `ActiveRemoteUpdateSession`, `isReinitializing` are read and written across
   what will become file boundaries. Do **not** re-export mutable `let`s. Give
   each new module an explicit `Configure({...})`/accessor surface — the pattern
   `IdentifyOverlay.Configure()` and `LaunchCountdownOverlay.Configure()`
   already use in this repo.
2. **`restartService` is a cycle risk.** It is called from IPC handlers, the
   broadcast bridge, and recovery, and it in turn calls `Main()`. Pass it in as a
   dependency (or hold it in a tiny `src/main/service-lifecycle.ts`) rather than
   letting three modules import `main.ts`.

Land this as one file-move-per-commit series, `npm test` green at each step, with
no behaviour changes mixed in. Then, in a _separate_ pass, add tests for
`recovery.ts` and `app-updater.ts` — the point of the split is that those two
finally become reachable, and they are the two that decide whether a client in
the field recovers or bricks itself on an update.

Target: `main.ts` coverage 51% → 80%+, driven by `recovery.ts` and
`app-updater.ts` becoming independently testable.

---

## WP-4 — Rewrite the Bonjour module

[Modules/Bonjour/index.ts](src/Modules/Bonjour/index.ts) — 370 lines, and the
worst-quality file in the tree:

- **42 empty `catch {}` blocks** in one file, plus a file-level
  `/* eslint-disable no-empty */`. Discovery failures are structurally
  unobservable, which is the exact failure mode operators report as "the client
  just never found the server".
- **`Stop()` and `Terminate()` are ~45 near-identical lines**, differing only in
  a trailing `instance.destroy()`. `finalizeFound` then re-implements the same
  teardown a third time. Three copies of teardown means a leaked timer or browser
  in one path is invisible in the others.
- **`__`-prefixed module globals** (`__updateTimer`, `__found`,
  `__fallbackLaunched`, …) — a naming convention used nowhere else in either app.
- **A bare `console.log`** at [:258](src/Modules/Bonjour/index.ts#L258), bypassing
  the Logger (so it never reaches the log file an operator sends back).
- **The `bonjour` package is effectively unmaintained** (`3.5.0`, no functional
  releases in years) and needs `@types/bonjour` bolted on — which is already
  wrong about the emitted events, requiring two `as NodeJS.EventEmitter` casts
  with explanatory comments at [:42](src/Modules/Bonjour/index.ts#L42) and
  [:342](src/Modules/Bonjour/index.ts#L342).
- Branch coverage 69.84%, the lowest of any fully-covered-by-line module.

Plan:

1. Migrate to `bonjour-service` (`1.4.3`) — the maintained, TypeScript-native
   fork with the same conceptual API. Drops `@types/bonjour` and both
   `EventEmitter` casts.
2. Collapse teardown into one internal `TeardownAll({ destroyInstance })`, called
   by `Stop`, `Terminate`, and `finalizeFound`.
3. Replace every empty catch with a `Logger.debug`/`Logger.warn`. Where a throw
   genuinely cannot matter, say so in one shared comment rather than 42 silent
   blocks. Remove the file-level `eslint-disable`.
4. Rename `__x` globals to the repo's convention.
5. Hoist the magic numbers (`10000` timeout ×2, `5000` update tick, `100`
   initial-update delay, `3000` diagnostic window) to named constants.
6. Reassess the per-interface fallback. It creates `interfaces × 2` Bonjour
   instances (it tries both `'showtrak'` and `'ShowTrak'` "just in case"); on a
   multi-NIC show machine that is a lot of sockets. Confirm whether the
   `'ShowTrak'` casing is still needed by any shipped server version, and drop
   it if not — that halves the instance count.

Keep the behaviour identical otherwise; discovery is load-bearing and the
fallback exists because real venue networks needed it.

---

## WP-5 — Extract cross-cutting duplication

1. **The `ServerIdentity` read idiom appears 10 times** across `main.ts` (×3),
   `MainClient`, `AdoptionClient`, and `ProfileManager` — the same
   "`typeof X.ServerIdentity === 'string' ? X.ServerIdentity.trim() : ''`" ladder,
   in two subtly different flavours (`''` vs `null` on absence). That difference
   is exactly the kind of thing that makes an identity check pass where it should
   fail. Extract `ReadServerIdentity(source): string | null` into
   `Modules/Utils` and use it everywhere.

2. **The `[error, value]` error-message ladder** —
   `Err && (Err as Error).message ? String((Err as Error).message) : 'fallback'`
   — appears in `main.ts`, `MainClient` (×3), `ScriptManager`, and `ProcessMonitor`.
   Extract `ErrorMessage(err, fallback)`.

3. **Renderer-send guard ×10** and **`assertNoArgs` ×11** — both absorbed by
   WP-3's `renderer-bus.ts` and `rpc.ts`.

4. **The run-once launch guard is duplicated across a process boundary**:
   `launchSequenceStarted` in
   [MainClient:32](src/Modules/MainClient/index.ts#L32) and
   `LaunchActionsHandled` in [main.ts:603](src/main.ts#L603) enforce the same
   invariant in two files. Both are commented as intentional belt-and-braces —
   keep both, but note the pairing in each comment so a future reader removing
   one knows what the other is for.

5. **Two overlapping delay mechanisms in recovery**: `RECOVERY_COOLDOWN_MS`
   (15s, gate) and `RECOVERY_BACKOFF_BASE/MAX_MS` (1s→10s, exponential wait)
   both throttle the same retry loop, and the backoff ceiling sits _below_ the
   cooldown floor, so the backoff can never be the binding constraint. Not a bug,
   but it is two mental models for one behaviour. Fold into a single documented
   schedule when `recovery.ts` is extracted.

---

## WP-6 — Renderer `UI/js/app/main.ts`

**0% coverage — the only file in the repo at zero.** The pure decision layer was
already extracted to `lib/status-models.ts` (100% covered), so what remains is
267 lines of jQuery painting. Three issues:

1. **HTML interpolation instead of text.**
   [:40-63](src/UI/js/app/main.ts#L40-L63) builds markup with `$('#PROFILE').html()`
   and interpolates `Profile.Server.IP`, `Profile.Server.Port`, and `Profile.UUID`
   — values that originate from a server payload. Low practical severity (they
   are IP/port/UUID shaped) but it is an injection sink in a `contextIsolation`
   window for no benefit. Restructure to a static template plus `.text()` calls
   on stable child nodes.
2. **A redundant duplicate call.** `ApplyProfile` calls `RenderManualServer()`
   twice — [:38](src/UI/js/app/main.ts#L38) and
   [:65](src/UI/js/app/main.ts#L65). Drop one.
3. **Split initialisation.** Some handlers bind inside `Main()` with `.off()`
   first; `SetProfile`, `BTN_MINIMIZE`, `BTN_SHUTDOWN`, and `BTN_FACTORY_RESET`
   bind at module top level without it
   ([:243-267](src/UI/js/app/main.ts#L243-L267)). Move all binding into `Main()`
   with the same `.off().on()` shape.

Per the standing no-jsdom decision, do not chase coverage here with a DOM
harness. Instead push the remaining branching logic (which element gets which
class, which string is shown) down into `lib/status-models.ts` so it is covered
as pure functions, leaving `main.ts` as thin, obviously-correct paint calls.
Also replace the three `console.log`/`console.error` calls with the Logger path
if one is reachable from the renderer, or drop them.

---

## WP-7 — Tooling parity with the Server

Small, and stops future drift.

1. **Husky is installed but inert.** `package.json` has `"prepare": "husky"` and
   husky `^9.1.7`, and `.husky/_/` exists — but **there is no hook file**. The
   Server has `.husky/pre-commit` containing `npx eslint .`. Add the same file
   here. Right now the dependency and the `prepare` script imply a guarantee the
   repo does not actually have.
2. **No `.github/dependabot.yml`.** The Server has one (weekly npm + GitHub
   Actions, dev-dependencies grouped, limit 5). Copy it verbatim. Given WP-2's
   backlog, this is what stops it re-accumulating.
3. Consider adding `npm run test:coverage` to CI as a **reported, non-gating**
   step, so coverage movement is visible in PRs. This respects the
   "no coverage gate" decision while making regressions noticeable.

---

## WP-8 — Naming & typo cleanup

Cosmetic, but on public-ish surfaces, so worth one sweep:

- `ProfileManager.ResetAdopption()` → `ResetAdoption()`
  ([ProfileManager:313](src/Modules/ProfileManager/index.ts#L313), called from
  [main.ts:1055](src/main.ts#L1055)).
- The `AdoptionClient` logger alias is `'AdopptionClient'`
  ([AdoptionClient:10](src/Modules/AdoptionClient/index.ts#L10)) — this string
  lands in every log line the module writes, so it is what operators grep for.
- `Logger.Tag` labels every client log line `[ShowTrakServer]`
  ([Logger:38](src/Modules/Logger/index.ts#L38)). In a support bundle containing
  both apps' logs this is actively misleading. → `[ShowTrakClient]`.
- Two stray `console.log`s outside the Logger:
  [MainClient:399](src/Modules/MainClient/index.ts#L399) and
  [Bonjour:258](src/Modules/Bonjour/index.ts#L258) (the latter handled by WP-4).
- Mixed local-variable casing in `main.ts` (`Info`, `Candidate`, `Profile`
  alongside `mainWindow`, `tray`, `recoveryInProgress`). Settle on the existing
  house style per scope during WP-3's moves rather than as a separate churn PR.

---

## Two things deliberately **not** proposed

- **Import-time side effects.** `Modules/OS` starts an unref'd 1-second
  `setInterval` at import ([OS:55](src/Modules/OS/index.ts#L55)); `Modules/Logger`
  creates directories and writes a file at import. Both are genuinely awkward for
  testing and would be wrong in a library. But both are load-bearing here (CPU
  sampling must start before the first heartbeat; logging must work before any
  module can fail), both are already fully covered, and making them lazy risks a
  first-heartbeat regression for no user-visible gain. Leave them; the cost is
  paid and understood.
- **Renderer framework / build changes.** esbuild + jQuery + vendored Bootstrap
  is a deliberate choice and works. Not touching it.

---

## Suggested sequencing

**Release A (security):** WP-1a, 1b, 1c, 1e · WP-7 · WP-2 minor/patch batch + dead-dep removal.
Small, high-value, low-regression-risk. Ship first.

**Release B (runtime):** WP-2 Electron 37→43, then `usb`/`@electron/fuses`, then
ESLint 10 — each its own PR, with manual tray/overlay/updater verification on
macOS and Windows between them.

**Release C (structure):** WP-3, mechanically, one move per commit. Then the new
tests for `recovery.ts` and `app-updater.ts`. Then WP-5.

**Release D (cleanup):** WP-4 · WP-6 · WP-8 · WP-1d (the AppData move, with its
migration, alone in its own release so a macOS profile-loss regression is
immediately attributable).
