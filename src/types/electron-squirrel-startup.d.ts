// `electron-squirrel-startup` ships no type declarations. It exports a single
// boolean: true when the process was spawned by the Squirrel installer to
// handle an install/update/uninstall event, in which case the app should quit
// immediately rather than showing a window.
declare module 'electron-squirrel-startup' {
  const squirrelStartupEvent: boolean;
  export = squirrelStartupEvent;
}
