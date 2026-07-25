// package.json sits outside `rootDir`, so it cannot be a plain import without
// pulling the repo root into the compiled output. The require is type-annotated
// instead — erased at compile time, and the relative depth is identical from
// dist/Modules/Config/, so runtime resolution is unchanged.
const Package = require('../../../package.json') as { version?: string };

const Version = Package.version || '0.0.0';

export const Config = {
  Application: {
    Version,
    Name: 'ShowTrak Client',
  },
  Shared: {
    Version,
  },
};
