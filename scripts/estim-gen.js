'use strict';
// estim step 2: re-run the extension's own "Generate Build Files" pipeline
// (Makefile + .cproject sync + IntelliSense) after manual edits to
// .mrs-project.json / Link.ld / sources. Same code path as the command.
require('../test/stub/vscode').install();

const { MrsInstallation } = require('../dist-tsc/locator/mrsInstallation');
const { loadProject } = require('../dist-tsc/project/projectModel');
const { finalizeProject } = require('../dist-tsc/project/projectCreator');

const local = (() => {
  try { return require('./local.json'); }
  catch { throw new Error('缺 scripts/local.json（本机路径清单，模板见 verify-e2e.js 注释）'); }
})();
const MRS2_ROOT = local.mrs2;
const DEST = local.estimDest;

async function main() {
  const loaded = await MrsInstallation.load(MRS2_ROOT);
  if ('error' in loaded) throw new Error(loaded.error);
  const proj = await loadProject(DEST);
  if ('error' in proj) throw new Error(proj.error);
  await finalizeProject(loaded, DEST, proj);
  console.log('regenerated: srcDirs =', proj.build.srcDirs.join(', '));
  console.log('excluded =', (proj.build.excludedPaths || []).join(', ') || '(none)');
  console.log('cFlagsExtra =', (proj.build.cFlagsExtra || []).join(' ') || '(none)');
}

main().catch((e) => { console.error(e); process.exit(1); });
