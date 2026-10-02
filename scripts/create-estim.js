'use strict';
// Generate the estim project via the SAME pipeline the extension wizard uses
// (createProject), at the design folder — the double-space path doubles as a
// real-world test of the extension's space-in-path handling.
require('../test/stub/vscode').install();

const path = require('path');
const { MrsInstallation } = require('../dist-tsc/locator/mrsInstallation');
const { createProject } = require('../dist-tsc/project/projectCreator');
const { loadProject } = require('../dist-tsc/project/projectModel');
const { syncCproject } = require('../dist-tsc/gen/cprojectGen');

const local = (() => {
  try { return require('./local.json'); }
  catch { throw new Error('缺 scripts/local.json（本机路径清单，模板见 verify-e2e.js 注释）'); }
})();
const MRS2_ROOT = local.mrs2;
const DEST = local.estimDest;

async function main() {
  const loaded = await MrsInstallation.load(MRS2_ROOT);
  if ('error' in loaded) throw new Error(loaded.error);
  const inst = loaded;
  const series = inst.chipDb.findSeries('CH32V003');
  if (!series) throw new Error('CH32V003 series not found');
  const proj = await createProject(inst, {
    series,
    mcuId: 'CH32V003F4P',
    destDir: DEST,
    createdFrom: 'template',
  });
  console.log('created:', proj.mcu.mcuId, 'target', proj.build.targetName);
  console.log('srcDirs:', proj.build.srcDirs.join(', '));
  console.log('linker:', proj.build.linkerScript, 'defines:', proj.build.defines.join(' '));

  // Re-run sync after any manual edits later; here just confirm it is a no-op-clean state.
  await syncCproject(DEST, proj);
  const check = await loadProject(DEST);
  console.log('reloaded ok, srcDirs:', check.build.srcDirs.join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
