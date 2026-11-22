// `npm run publish`: cuts a release of this app. Dispatches the Build workflow,
// waits for it, and reports what came out the other end.
//
// Shared with ShowTrak Server and Timers: shared/scripts/publish-release.js has
// the usage and the checks, and reads everything else (owner/repo, branch,
// version, submodules) from the checkout passed in here.
const path = require('node:path');

require('../shared/scripts/publish-release').main({ root: path.resolve(__dirname, '..') });
