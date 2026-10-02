'use strict';
/**
 * End-to-end verification against the real MRS2 installation (no VSCode).
 * Gates (from the implementation plan):
 *   S0  installation loads, chip database populated
 *   S1  template CH32V003F4P  → make → elf/hex/bin/lst/map
 *   S2  template CH582F       → make → …
 *   S3  template CH32F103C8T  → make → …
 *   S4  example GPIO_Toggle (MRS2 style, SDK fills shared sources)
 *   S5  example CH583 BLE Peripheral (MRS1 style, SRC pool + BLE lib)
 *   S6  import: BLE Peripheral copied to temp → import → make
 */
require('../test/stub/vscode').install();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 本机路径放 scripts/local.json（.gitignore 排除，仓库不含机器特定配置）：
// { "mrs2": "<MRS2 根>", "work": "<临时工作目录>", "examples": "<例程库>", "estimDest": "<estim 工程>" }
const local = (() => {
  try { return require('./local.json'); }
  catch { throw new Error('缺 scripts/local.json（本机路径清单，模板见上方注释）'); }
})();
const MRS2_ROOT = local.mrs2;
const WORK = local.work;
const EXAMPLES = local.examples;

const { MrsInstallation } = require('../dist-tsc/locator/mrsInstallation');
const { createProject } = require('../dist-tsc/project/projectCreator');
const { makeEnv } = require('../dist-tsc/build/makeEnv');
const { scanExampleLibrary } = require('../dist-tsc/examples/exampleLibrary');

let failures = 0;
function ok(cond, label, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

function run(exe, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    const feed = (b) => (out += b.toString('utf-8'));
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: -1, out: out + '\n' + String(err) }));
    setTimeout(() => { try { child.kill(); } catch {} }, 300000);
  });
}

async function make(inst, proj, dir, label) {
  const res = await run(inst.makeExe, ['all', 'CONFIG=debug'], { cwd: dir, env: makeEnv(inst, proj) });
  if (res.code !== 0) {
    console.log(res.out.split('\n').slice(-30).join('\n'));
  }
  ok(res.code === 0, `${label}: make exit 0 (got ${res.code})`);
  return res;
}

function checkArtifacts(dir, target, label) {
  const obj = path.join(dir, 'obj');
  for (const ext of ['.elf', '.hex', '.bin', '.lst', '.map']) {
    const p = path.join(obj, target + ext);
    ok(fs.existsSync(p) && fs.statSync(p).size > 0, `${label}: obj/${target}${ext}`);
  }
}

async function buildOne(inst, seriesName, mcuId, destDir, createdFrom, exampleDir, label, searchRoots) {
  console.log(`\n== ${label} ==`);
  const series = inst.chipDb.findSeries(seriesName);
  if (!series) {
    ok(false, `${label}: series ${seriesName} found`);
    return;
  }
  if (createdFrom !== 'import') {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  const proj = await createProject(inst, { series, mcuId, destDir, createdFrom, exampleDir, searchRoots });
  ok(true, `${label}: created (${proj.build.srcDirs.length} srcDirs: ${proj.build.srcDirs.join(', ')})`);
  console.log(`      linker=${proj.build.linkerScript} defines=${proj.build.defines.join(' ')} libs=[${proj.build.libDirs.join(',')}]`);
  await make(inst, proj, destDir, label);
  checkArtifacts(destDir, proj.build.targetName, label);
  return proj;
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log('== S0: installation ==');
  const loaded = await MrsInstallation.load(MRS2_ROOT);
  if ('error' in loaded) {
    ok(false, 'MrsInstallation.load', loaded.error);
    process.exit(1);
  }
  const inst = loaded;
  console.log(inst.summary);
  ok(inst.chipDb.series.length >= 30, 'series count >= 30', String(inst.chipDb.series.length));
  ok(inst.chipDb.findSeries('CH58X')?.mcus.some((m) => m.id === 'CH582F'), 'CH582F in CH58X');
  ok(inst.chipDb.findSeries('CH32V003')?.mcus.some((m) => m.id === 'CH32V003F4P'), 'CH32V003F4P in CH32V003');
  ok(inst.chipDb.findSeries('CH32F103')?.mcus.some((m) => m.id === 'CH32F103C8T'), 'CH32F103C8T in CH32F103');

  // S1-S3: blank template projects
  await buildOne(inst, 'CH32V003', 'CH32V003F4P', path.join(WORK, 'tpl_CH32V003F4P'), 'template', undefined, 'S1 template CH32V003F4P');
  await buildOne(inst, 'CH58X', 'CH582F', path.join(WORK, 'tpl_CH582F'), 'template', undefined, 'S2 template CH582F');
  await buildOne(inst, 'CH32F103', 'CH32F103C8T', path.join(WORK, 'tpl_CH32F103C8T'), 'template', undefined, 'S3 template CH32F103C8T');

  // S4: MRS2-style example — shared sources from SDK template
  await buildOne(
    inst, 'CH32V003', 'CH32V003F4P', path.join(WORK, 'ex_gpio_toggle'), 'example',
    path.join(EXAMPLES, 'CH32V00x', 'EVT', 'EXAM', 'GPIO', 'GPIO_Toggle'),
    'S4 example GPIO_Toggle',
  );

  // S5: MRS1-style example — complete project + SRC pool + prebuilt BLE lib
  const s5 = await buildOne(
    inst, 'CH58X', 'CH583M', path.join(WORK, 'ex_ble_peripheral'), 'example',
    path.join(EXAMPLES, 'CH583', 'EVT', 'EXAM', 'BLE', 'Peripheral'),
    'S5 example CH583 BLE Peripheral',
  );
  if (s5) {
    // CH58x-specific: BLE lib linked, .highcode present, CHIP_ID defined.
    const objDir = path.join(WORK, 'ex_ble_peripheral', 'obj');
    const mapPath = path.join(objDir, s5.build.targetName + '.map');
    const mapText = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf-8') : '';
    ok(mapText !== '', 'S5: map file exists');
    ok(/\.highcode/.test(mapText), 'S5: .highcode section in map');
    ok(/CH58xBLE/i.test(mapText), 'S5: BLE lib in map');
    ok(s5.build.defines.some((d) => /^CHIP_ID=/.test(d)), 'S5: CHIP_ID define', s5.build.defines.join(' '));
    const elfPath = path.join(objDir, s5.build.targetName + '.elf');
    const elfSize = fs.existsSync(elfPath) ? fs.statSync(elfPath).size : 0;
    ok(elfSize > 10000, 'S5: elf is a real image', `${elfSize} bytes`);
  }

  // S6: import — copy the example to a temp dir first (never touch user projects)
  console.log('\n== S6: import ==');
  const srcExample = path.join(EXAMPLES, 'CH583', 'EVT', 'EXAM', 'BLE', 'Peripheral');
  const importDir = path.join(WORK, 'import_ble_peripheral');
  fs.cpSync(srcExample, importDir, {
    recursive: true,
    filter: (s) => !/[\\/]obj([\\/]|$)/i.test(s) && !s.endsWith('.wvproj'),
  });
  const s6 = await buildOne(inst, 'CH58X', 'CH583M', importDir, 'import', undefined, 'S6 import BLE Peripheral (temp copy)', [EXAMPLES]);
  ok(s6?.build.defines.some((d) => /^CHIP_ID=/.test(d)), 'S6: CHIP_ID define');

  // Example library scan smoke test
  console.log('\n== S7: example library scan ==');
  const lib = scanExampleLibrary(EXAMPLES);
  ok(lib.examples.length > 200, 'examples discovered', String(lib.examples.length));
  const styles = new Set(lib.examples.map((e) => e.style));
  ok(styles.has('keil') && styles.has('mrs2'), 'keil + mrs2 styles recognized', [...styles].join(','));
  ok(
    !lib.examples.some((e) => /[\\/]SRC[\\/]/i.test(e.path) || /^(SRC|obj)$/i.test(e.name)),
    'SRC pools / obj excluded',
  );
  ok(
    lib.examples.some((e) => e.category.includes('/')),
    'nested categories (USB/USBD) resolved',
  );
  const chips = [...new Set(lib.examples.map((e) => e.chipFolder))];
  console.log('     chips:', chips.join(', '));
  for (const chip of chips) {
    ok(
      inst.chipDb.findSeries(lib.examples.find((e) => e.chipFolder === chip).series) !== undefined,
      `series resolvable for ${chip}`,
    );
  }

  // S8: user scenario — create into a NON-EXISTENT dir; BLE_UART ships the
  // PARENT-n links in <location> (not <locationURI>) and mutually exclusive
  // ble_uart_service*.c variants (sourceEntries excluding=…).
  const bleUart = lib.examples.find((e) => e.name === 'BLE_UART');
  if (bleUart) {
    const s8 = await buildOne(
      inst,
      'CH58X',
      'CH582M',
      path.join(WORK, 'gone', 'deep', 'CH582M_BLE_UART'),
      'example',
      bleUart.path,
      'S8 BLE_UART -> CH582M (dest dir missing)',
      [EXAMPLES],
    );
    ok((s8?.build.excludedPaths?.length ?? 0) > 0, 'S8: build exclusions carried over');
    ok(
      s8?.build.defines.some((d) => /^CHIP_ID=CH582$/.test(d)) === true,
      'S8: CHIP_ID=CH582 for CH582M target',
    );
  } else {
    ok(false, 'S8: BLE_UART example found in library');
  }

  // S9: MRS2 interop — the .cproject in the S8 project must carry the model's
  // includes/defines/linker/lib list (the SDK template's stale "../StdPeriphDriver"
  // values are what made MRS2 fail with `fatal error: HAL.h`). Simulate the
  // MRS2-side compile: syntax-check a HAL source with ONLY the values parsed
  // back out of the patched .cproject.
  console.log('\n== S9: .cproject MRS2 interop ==');
  const s9dir = path.join(WORK, 'gone', 'deep', 'CH582M_BLE_UART');
  if (fs.existsSync(path.join(s9dir, '.cproject'))) {
    const raw = fs.readFileSync(path.join(s9dir, '.cproject'), 'utf-8');
    const parsed = require('../dist-tsc/examples/cprojectParser').parseProjectFile(s9dir);

    ok(
      ['HAL/include', 'APP/include', 'RVMSIS', 'StdPeriphDriver/inc'].every((p) =>
        parsed.includePaths.includes(p),
      ),
      'S9: .cproject include paths cover HAL/APP/RVMSIS/StdPeriphDriver',
      parsed.includePaths.join(', '),
    );
    ok(parsed.defines.includes('CH583') && parsed.defines.some((d) => d === 'CHIP_ID=CH582'),
      'S9: .cproject defines carry CH583 + CHIP_ID', parsed.defines.join(' '));
    ok(parsed.excludedPaths.includes('HAL/KEY.c') && parsed.excludedPaths.includes('HAL/LED.c'),
      'S9: .cproject mirrors per-file exclusions');
    ok(raw.includes('${ProjName}/Ld/Link.ld'), 'S9: linker script inside the project');
    ok(/value="CH58xBLE"/.test(raw), 'S9: -l CH58xBLE derived from libCH58xBLE.a');

    const s9proj = await require('../dist-tsc/project/projectModel').loadProject(s9dir);
    const tc = inst.toolchains.resolve(s9proj.mcu.toolchainName);
    const isa = inst.chipDb.findSeries(s9proj.mcu.series)?.isa;
    const gcc = path.join(tc.binDir, tc.prefix + 'gcc.exe');
    const probe = path.join(s9dir, 'HAL', 'MCU.c');
    if (tc && isa && fs.existsSync(probe)) {
      const args = [
        ...isa.cpuFlags.split(' '),
        '-std=gnu99',
        ...parsed.defines.map((d) => `-D${d}`),
        ...parsed.includePaths.map((i) => `-I${i}`),
        '-fsyntax-only',
        'HAL/MCU.c',
      ];
      const res = await run(gcc, args, { cwd: s9dir });
      ok(res.code === 0, 'S9: HAL/MCU.c compiles with .cproject values only (MRS2 simulation)',
        res.code === 0 ? '' : res.out.split('\n').filter(Boolean).slice(-3).join(' | '));
    } else {
      ok(false, 'S9: toolchain/ISA/probe source available');
    }
  } else {
    ok(false, 'S9: S8 project has a .cproject');
  }

  console.log(`\n== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ==`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
