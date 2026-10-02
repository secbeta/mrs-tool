'use strict';
/** Unit tests for the pure logic modules, run against dist-tsc output. */
require('../stub/vscode').install();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { deriveIsa } = require('../../dist-tsc/chipdb/isaMap');
const { parseTemplateManifest } = require('../../dist-tsc/chipdb/chipDatabase');
const { renderMakefile } = require('../../dist-tsc/gen/makefileGen');
const { suggestChipDefine, scanProject } = require('../../dist-tsc/project/projectScanner');
const { parseProjectFile } = require('../../dist-tsc/examples/cprojectParser');
const { defaultProject } = require('../../dist-tsc/project/projectModel');

let failures = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// ---- isaMap ----------------------------------------------------------------
test('deriveIsa: CH58X-style rv32imac/ilp32', () => {
  const isa = deriveIsa({
    architecture: 'rv32i',
    multiply_extension: true,
    atomic_extension: true,
    compressed_extension: true,
    integer_ABI: 'ilp32',
  });
  assert.strictEqual(isa.cpuFlags, '-march=rv32imac -mabi=ilp32');
  assert.strictEqual(isa.arch, 'riscv');
});

test('deriveIsa: rv32e defaults to ilp32e', () => {
  const isa = deriveIsa({ architecture: 'rv32e', compressed_extension: true });
  assert.strictEqual(isa.cpuFlags, '-march=rv32ec -mabi=ilp32e');
});

test('deriveIsa: fp appends f and f-suffixed ABI', () => {
  const isa = deriveIsa({ architecture: 'rv32i', floating_point: 'single', integer_ABI: 'ilp32' });
  assert.strictEqual(isa.cpuFlags, '-march=rv32if -mabi=ilp32f');
});

test('deriveIsa: ARM branch', () => {
  const isa = deriveIsa({ armFamily: 'cortex-m3' });
  assert.strictEqual(isa.cpuFlags, '-mcpu=cortex-m3 -mthumb');
  assert.strictEqual(isa.arch, 'arm');
});

// ---- .template parser -------------------------------------------------------
test('parseTemplateManifest: INI-like sections', () => {
  const m = parseTemplateManifest('[MounRiver]\nMcu Type=CH58x\nAddress=0x00000000\nErase All=true\nProgram=TRUE\nVendor=WCH\n');
  assert.strictEqual(m.mcuType, 'CH58x');
  assert.strictEqual(m.address, '0x00000000');
  assert.strictEqual(m.eraseAll, true);
  assert.strictEqual(m.program, true);
  assert.strictEqual(m.vendor, 'WCH');
});

// ---- Makefile render --------------------------------------------------------
function fakeProject() {
  return defaultProject({
    toolchainType: 'RISC-V',
    toolchainName: 'GCC8',
    series: 'CH58X',
    mcuId: 'CH582F',
    mcuType: 'CH58x',
    srcDirs: ['APP', 'Startup'],
    libDirs: ['LIB'],
    linkerScript: 'Ld/Link.ld',
    defines: ['DEBUG=1', 'CHIP_ID=CH582'],
    createdFrom: 'template',
  });
}

function fakeInst() {
  return {
    toolchains: {
      resolve: () => ({ binDir: 'C:/MRS2/RISC-V Embedded GCC/bin', prefix: 'riscv-none-embed-' }),
    },
    chipDb: {
      findSeries: () => ({ isa: { cpuFlags: '-march=rv32imac -mabi=ilp32' } }),
    },
  };
}

test('renderMakefile: core invariants', () => {
  const mk = renderMakefile(fakeProject(), fakeInst());
  assert.ok(mk.includes('rwildcard'), 'rwildcard present');
  assert.ok(mk.includes("$(call rwildcard,$(SRC_DIRS),%)"), 'all-files pattern uses %');
  assert.ok(mk.includes('%.h'), 'header pattern uses %');
  assert.ok(mk.includes('%.a'), 'lib pattern uses %');
  assert.ok(mk.includes('-Wl,--start-group $(PREBUILT_LIBS) -Wl,--end-group'), 'lib group');
  assert.ok(mk.includes('-DCHIP_ID=CH582'), 'defines');
  assert.ok(mk.includes('%.S | dirs'), 'asm rules carry dirs order-only prereq');
  assert.ok(mk.includes('$(ASM_UPPER:%.S=$(BUILD_DIR)/%.o)'), 'asm object substitution');
  assert.ok(!mk.includes('*.$(ALL_FILES)'), 'no mangled patterns');
});

test('renderMakefile: build exclusions', () => {
  const proj = fakeProject();
  proj.build.excludedPaths = ['APP/svc/variant.c', 'APP/svc2', 'StdPeriphDriver/CH57x_uart0.c'];
  const mk = renderMakefile(proj, fakeInst());
  assert.ok(mk.includes('EXCLUDED      := APP/svc/variant.c APP/svc2 StdPeriphDriver/CH57x_uart0.c'));
  assert.ok(mk.includes('EXCLUDE_PATS  := $(EXCLUDED) $(EXCLUDED:%=%/%)'));
  assert.ok(
    mk.includes('C_SOURCES     := $(filter-out $(EXCLUDE_PATS),$(C_SOURCES))'),
    'c sources filtered',
  );
  const plain = renderMakefile(fakeProject(), fakeInst());
  assert.ok(!plain.includes('EXCLUDE_PATS'), 'no exclusion block without excludedPaths');
});

// ---- scanner ----------------------------------------------------------------
test('suggestChipDefine: CH5xx id minus suffix', () => {
  assert.strictEqual(suggestChipDefine('CH582F', 'CH58X'), 'CHIP_ID=CH582');
  assert.strictEqual(suggestChipDefine('CH583M', 'CH58X'), 'CHIP_ID=CH583');
  assert.strictEqual(suggestChipDefine('CH32V003F4P', 'CH32V003'), undefined);
});

test('scanProject: srcDirs/libDirs/linker discovery', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-scan-'));
  fs.mkdirSync(path.join(tmp, 'APP', 'inc'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'Ld'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'LIB'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'APP', 'main.c'), 'int main(void){for(;;);}\n');
  fs.writeFileSync(path.join(tmp, 'Ld', 'Link.ld'), 'ENTRY(_start)\n');
  fs.writeFileSync(path.join(tmp, 'LIB', 'libCH58xBLE.a'), 'x');
  const scanned = scanProject(tmp);
  assert.ok(scanned.srcDirs.includes('APP'), 'APP in srcDirs');
  assert.ok(scanned.libDirs.includes('LIB'), 'LIB in libDirs');
  assert.strictEqual(scanned.linkerScript, 'Ld/Link.ld');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- cprojectParser ---------------------------------------------------------
test('parseProjectFile: linkedResources + defines', () => {
  // PARENT-1-PROJECT_LOC points OUTSIDE the project dir: root/{project,shared}.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-cproj-'));
  const tmp = path.join(root, 'project');
  fs.mkdirSync(path.join(root, 'shared', 'SRC', 'Ld'), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, '.project'), `<?xml version="1.0"?>
<projectDescription>
 <linkedResources>
  <link><name>Ld</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/shared/SRC/Ld</locationURI></link>
  <link><name>HAL</name><type>2</type><location>PARENT-1-PROJECT_LOC/shared/HAL</location></link>
  <link><name>Gone</name><type>2</type><locationURI>PARENT-1-PROJECT_LOC/nope</locationURI></link>
 </linkedResources>
</projectDescription>`);
  fs.mkdirSync(path.join(root, 'shared', 'HAL'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.cproject'), `<?xml version="1.0"?>
<cproject>
 <option id="x" superClass="definedSymbols" valueType="definedSymbols">
  <listOptionValue builtIn="false" value="DEBUG=1"/>
  <listOptionValue builtIn="false" value="CHIP_ID=CH582"/>
 </option>
 <sourceEntries>
  <entry excluding="APP/svc/variant.c|APP/svc2|RVMSIS" flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name=""/>
  <entry excluding="Profile|KEY.c|LED.c" flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="HAL"/>
  <entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="RVMSIS"/>
 </sourceEntries>
</cproject>`);
  const info = parseProjectFile(tmp);
  assert.strictEqual(info.linkedFolders.length, 2, 'Ld (locationURI) + HAL (location)');
  assert.strictEqual(info.linkedFolders[0].name, 'Ld');
  assert.strictEqual(info.linkedFolders[1].name, 'HAL');
  assert.deepStrictEqual(info.defines.sort(), ['CHIP_ID=CH582', 'DEBUG=1']);
  assert.strictEqual(info.unresolvedLinks.length, 1);
  assert.strictEqual(info.unresolvedLinks[0].name, 'Gone');
  assert.deepStrictEqual(info.excludedPaths, [
    'APP/svc/variant.c',
    'APP/svc2',
    'HAL/Profile',
    'HAL/KEY.c',
    'HAL/LED.c',
  ], 'RVMSIS cancelled by its own sourcePath entry');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- exampleLibrary ----------------------------------------------------------
const { scanExampleLibrary } = require('../../dist-tsc/examples/exampleLibrary');test('scanExampleLibrary: categories are not examples, nesting + pools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-exlib-'));
  const mk = (...p) => {
    const d = path.join(root, ...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const touch = (...p) => fs.closeSync(fs.openSync(path.join(root, ...p), 'w'));

  // Keil style: named project file, flat sources, inside a category.
  const keil = mk('CH32F103', 'EVT', 'EXAM', 'GPIO', 'Toggle');
  touch('CH32F103', 'EVT', 'EXAM', 'GPIO', 'Toggle', 'CH32F10x.uvprojx');
  touch('CH32F103', 'EVT', 'EXAM', 'GPIO', 'Toggle', 'Main.c');
  // A User/ source folder must not become its own example.
  const keilUser = mk('CH32F103', 'EVT', 'EXAM', 'USB', 'CDC', 'user');
  touch('CH32F103', 'EVT', 'EXAM', 'USB', 'CDC', 'CH32F10x.uvprojx');
  touch('CH32F103', 'EVT', 'EXAM', 'USB', 'CDC', 'user', 'Main.c');
  // Nested category: USB/USBD/<example>.
  mk('CH32F103', 'EVT', 'EXAM', 'USB', 'USBD', 'HID');
  touch('CH32F103', 'EVT', 'EXAM', 'USB', 'USBD', 'HID', 'HID.uvprojx');
  // Shared source pool under EXAM must be skipped entirely.
  mk('CH32F103', 'EVT', 'EXAM', 'SRC');
  touch('CH32F103', 'EVT', 'EXAM', 'SRC', 'Driver.c');
  // Prebuilt-lib support folder is not an example.
  const libDir = mk('CH32F103', 'EVT', 'EXAM', 'USB', 'USBFS', 'Udisk_Lib');
  touch('CH32F103', 'EVT', 'EXAM', 'USB', 'USBFS', 'Udisk_Lib', 'UFI.c');
  touch('CH32F103', 'EVT', 'EXAM', 'USB', 'USBFS', 'Udisk_Lib', 'UFI.lib');
  // MRS2 style: dotfile .cproject + named .wvproj + User/ subdir.
  const mrs2 = mk('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle');
  touch('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle', '.cproject');
  touch('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle', 'Gpio_Toggle.wvproj');
  mk('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle', 'User');
  touch('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle', 'User', 'main.c');

  const lib = scanExampleLibrary(root);
  const byName = new Map(lib.examples.map((e) => [e.name, e]));

  assert.strictEqual(lib.examples.length, 4, `got ${lib.examples.map((e) => e.category + '/' + e.name).join(', ')}`);
  const toggle = byName.get('Toggle');
  assert.strictEqual(toggle.category, 'GPIO');
  assert.strictEqual(toggle.style, 'keil');
  assert.strictEqual(toggle.chipFolder, 'CH32F103');
  const hid = byName.get('HID');
  assert.strictEqual(hid.category, 'USB/USBD');
  const gpioT = byName.get('Gpio_Toggle');
  assert.strictEqual(gpioT.style, 'mrs2');
  assert.strictEqual(gpioT.series, 'CH32V003');
  // No entry may sit at/under the pool, the lib folder, or a User dir.
  for (const e of lib.examples) {
    assert.ok(!/[\\/]SRC([\\/]|$)/.test(e.path), 'SRC leaked: ' + e.path);
    assert.ok(!/Udisk_Lib|user([\\/]|$)/i.test(e.path), 'source dir leaked: ' + e.path);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- findWorkspaceProjects ----------------------------------------------------
const stubVscode = require('../stub/vscode');
const { findWorkspaceProjects } = require('../../dist-tsc/project/projectModel');

test('findWorkspaceProjects: nested markers, no descent into projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-roots-'));
  const marker = '.mrs-project.json';
  // Project nested three levels below the workspace root (user's case:
  // workspace wch/ → ch582/test/CH582M).
  fs.mkdirSync(path.join(root, 'ch582', 'test', 'CH582M'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ch582', 'test', 'CH582M', marker), '{}');
  // Inside a project folder we must NOT keep scanning.
  fs.mkdirSync(path.join(root, 'ch582', 'test', 'CH582M', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ch582', 'test', 'CH582M', 'inner', marker), '{}');
  // node_modules and dot-dirs are skipped.
  fs.mkdirSync(path.join(root, 'other', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other', 'node_modules', 'pkg', marker), '{}');
  fs.mkdirSync(path.join(root, '.git', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'x', marker), '{}');

  const prev = stubVscode.workspace.workspaceFolders;
  stubVscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  try {
    const roots = await findWorkspaceProjects();
    assert.deepStrictEqual(
      roots.map((r) => path.relative(root, r)),
      [path.join('ch582', 'test', 'CH582M')],
    );
  } finally {
    stubVscode.workspace.workspaceFolders = prev;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- serialPorts --------------------------------------------------------------
const { parsePnpPorts, parseRegPorts } = require('../../dist-tsc/serial/serialPorts');

test('parsePnpPorts: extracts ports, WCH first, non-COM lines ignored', () => {
  const stdout = [
    'USB\\VID_1A86&PID_7523\\5&2A3F&0&0|USB-SERIAL CH340 (COM7)',
    'ACPI\\PNP0501\\1|通信端口 (COM1)',
    'BTHENUM\\{00001101}\\7&1F3C|标准串行蓝牙链路 (COM3)',
    'USB\\VID_2341&PID_0043\\9503|Arduino Uno (COM12)',
    'USB\\VID_8087&PID_0026\\5|Intel(R) 无线 Bluetooth(R)',
    'garbage line without a port',
  ].join('\r\n');
  const ports = parsePnpPorts(stdout);
  assert.deepStrictEqual(ports.map((p) => p.port), ['COM7', 'COM1', 'COM3', 'COM12']);
  assert.strictEqual(ports[0].isWch, true, 'CH340 by VID_1A86');
  assert.strictEqual(ports[0].name, 'USB-SERIAL CH340 (COM7)');
  assert.strictEqual(ports[0].pnpId, 'USB\\VID_1A86&PID_7523\\5&2A3F&0&0');
  assert.strictEqual(ports[1].isWch, false, 'ACPI legacy port');
  assert.strictEqual(ports[2].isWch, false, 'Bluetooth SPP');
  assert.strictEqual(ports[3].isWch, false, 'Arduino');
});

test('parseRegPorts: SERIALCOMM rows, dedupe, numeric order', () => {
  const stdout = [
    '',
    'HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM',
    '    \\Device/VCP0    REG_SZ    COM7',
    '    \\Device/Serial0    REG_SZ    COM1',
    '    \\Device/BthModem0    REG_SZ    COM3',
    '',
  ].join('\r\n');
  const ports = parseRegPorts(stdout);
  assert.deepStrictEqual(ports.map((p) => p.port), ['COM1', 'COM3', 'COM7']);
  assert.ok(ports.every((p) => !p.isWch), 'registry rows carry no VID info');
  assert.deepStrictEqual(parseRegPorts(''), [], 'empty output → no ports');
});

// ---- ispFlasher (wchisp) --------------------------------------------------------
const { ispFlashArgs, detectIspHint } = require('../../dist-tsc/flash/ispFlasher');

test('ispFlashArgs: USB 默认 / 串口 / 设备序号，全局项在子命令前', () => {
  assert.deepStrictEqual(ispFlashArgs('obj/X.hex'), ['flash', 'obj/X.hex']);
  assert.deepStrictEqual(ispFlashArgs('obj/X.hex', { serialPort: 'COM5' }),
    ['--serial', '--port', 'COM5', 'flash', 'obj/X.hex']);
  assert.deepStrictEqual(ispFlashArgs('obj/X.hex', { deviceIndex: 1, serialPort: 'COM3' }),
    ['-d', '1', '--serial', '--port', 'COM3', 'flash', 'obj/X.hex']);
});

test('detectIspHint: DLL 缺失 / 无设备 / 串口占用 / 其它', () => {
  assert.ok(/CH375DLL64/.test(detectIspHint('wchisp: CH375DLL64.dll not found', 1)));
  assert.ok(/CH375DLL64/.test(detectIspHint('', 3221225781)), 'loader exit code 0xC0000135');
  assert.ok(/BOOT/.test(detectIspHint('Error: No USB device matches given VID/PID', 1)));
  assert.ok(/串口/.test(detectIspHint('serial: Failed to open COM5: 拒绝访问', 1)));
  assert.strictEqual(detectIspHint('wrote 16384 bytes', 0), undefined);
});

// ---- cprojectGen --------------------------------------------------------------
const { patchCproject, planFromProject } = require('../../dist-tsc/gen/cprojectGen');

const SYNTHETIC_CPROJECT = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?fileVersion 4.0.0?><cproject>
	<cconfiguration id="cfg">
		<storageModule moduleId="cdtBuildSystem" version="4.0.0">
			<configuration name="obj">
				<folderInfo name="/">
					<toolChain>
						<tool superClass="assembler">
							<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="true" id="asm.inc" superClass="opt.assembler.include.paths" valueType="includePath"/>
						</tool>
						<tool superClass="c.compiler">
							<option id="c.inc" superClass="opt.c.compiler.include.paths" valueType="includePath">
								<listOptionValue builtIn="false" value="&quot;../StdPeriphDriver/inc&quot;"/>
								<listOptionValue builtIn="false" value="&quot;../RVMSIS&quot;"/>
							</option>
							<option id="c.defs" superClass="opt.c.compiler.defs" valueType="definedSymbols">
								<listOptionValue builtIn="false" value="DEBUG=1"/>
								<listOptionValue builtIn="false" value="ISP583"/>
							</option>
							<option id="c.incfiles" superClass="opt.c.compiler.include.files" valueType="includeFiles">
								<listOptionValue builtIn="false" value="&quot;system.h&quot;"/>
							</option>
						</tool>
						<tool superClass="c.linker">
							<option id="ld.paths" superClass="opt.c.linker.paths" valueType="libPaths">
								<listOptionValue builtIn="false" value="&quot;../&quot;"/>
							</option>
							<option id="ld.script" superClass="opt.c.linker.scriptfile" valueType="stringList">
								<listOptionValue builtIn="false" value="&quot;../Ld/Link.ld&quot;"/>
							</option>
							<option id="ld.libs" superClass="opt.c.linker.libs" valueType="libs">
								<listOptionValue builtIn="false" value="ISP583"/>
							</option>
							<option id="ld.flags" superClass="opt.c.linker.flags" valueType="stringList">
								<listOptionValue builtIn="false" value="--print-memory-usage"/>
							</option>
						</tool>
					</toolChain>
				</folderInfo>
				<sourceEntries>
					<entry excluding="Ld|RVMSIS" flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name=""/>
					<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Ld"/>
				</sourceEntries>
			</configuration>
		</storageModule>
	</cconfiguration>
</cproject>`;

test('patchCproject: rewrites includes/defines/libs/script/excludes in workspace_loc form', () => {
  const plan = {
    includePaths: ['APP/include', 'HAL/include', 'RVMSIS', 'StdPeriphDriver/inc'],
    defines: ['DEBUG=1', 'CH583', 'CHIP_ID=CH582'],
    libPaths: ['LIB', 'StdPeriphDriver'],
    libNames: ['CH58xBLE'],
    linkerScript: 'Ld/Link.ld',
    excludedPaths: ['HAL/KEY.c', 'HAL/LED.c', 'APP/ble_uart_service/ble_uart_service.c'],
  };
  const out = patchCproject(SYNTHETIC_CPROJECT, plan);

  // Include paths: replaced everywhere (assembler self-closing form expands too).
  assert.ok(out.includes('&quot;${workspace_loc:/${ProjName}/HAL/include}&quot;'), 'HAL/include includePath');
  assert.ok(out.includes('&quot;${workspace_loc:/${ProjName}/APP/include}&quot;'), 'APP/include includePath');
  assert.ok(!out.includes('../StdPeriphDriver'), 'stale ../ include gone');
  assert.ok(!/IS_VALUE_EMPTY="true"[^>]*includePath/.test(out), 'assembler include list no longer empty');

  // Defines.
  assert.ok(out.includes('value="CH583"'), 'CH583 define');
  assert.ok(out.includes('value="CHIP_ID=CH582"'), 'CHIP_ID define');
  assert.ok(!out.includes('ISP583"'), 'template ISP583 define gone');

  // Libs & lib paths & linker script.
  assert.ok(out.includes('value="CH58xBLE"'), 'CH58xBLE -l lib');
  assert.ok(out.includes('&quot;${workspace_loc:/${ProjName}/LIB}&quot;'), 'LIB libPath');
  assert.ok(out.includes('&quot;${workspace_loc:/${ProjName}/Ld/Link.ld}&quot;'), 'linker script');
  assert.ok(!out.includes('../Ld/Link.ld'), 'stale ../ linker script gone');

  // Unrelated options survive untouched.
  assert.ok(out.includes('value="--print-memory-usage"'), 'linker flags stringList preserved');
  assert.ok(out.includes('valueType="includeFiles"'), 'include.files option preserved');

  // sourceEntries: single root entry with the model's exclusions.
  assert.ok(out.includes('excluding="HAL/KEY.c|HAL/LED.c|APP/ble_uart_service/ble_uart_service.c"'), 'excluding list');
  assert.strictEqual(out.match(/kind="sourcePath"/g).length, 1, 'single root source entry');
  assert.ok(!out.includes('kind="sourcePath" name="Ld"'), 'per-dir entries folded away');

  // Idempotent.
  assert.strictEqual(patchCproject(out, plan), out, 'patch is idempotent');
});

test('planFromProject: recursive header dirs + libCH58xBLE.a → CH58xBLE', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-cproj-'));
  try {
    for (const [dir, files] of [
      ['HAL', ['MCU.c']],
      ['HAL/include', ['HAL.h']],
      ['APP/include', ['app.h']],
      ['APP/src', ['main.c']],
      ['LIB', ['libCH58xBLE.a', 'ISP583.a']],
      ['obj', ['stale.h']],
    ]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      for (const f of files) {
        fs.writeFileSync(path.join(root, dir, f), 'x');
      }
    }
    const proj = defaultProject({
      toolchainType: 'RISC-V',
      toolchainName: 'GCC8',
      series: 'CH58X',
      mcuId: 'CH582M',
      mcuType: 'CH58x',
      srcDirs: ['APP', 'HAL'],
      libDirs: ['LIB'],
      linkerScript: 'Ld/Link.ld',
      defines: ['DEBUG=1'],
    });
    const plan = planFromProject(root, proj);
    assert.deepStrictEqual(plan.includePaths, ['APP/include', 'HAL/include']);
    assert.deepStrictEqual(plan.libNames, ['CH58xBLE', 'ISP583'], 'lib- prefix stripped, bare .a kept');
    assert.deepStrictEqual(plan.libPaths, ['LIB']);
    assert.strictEqual(plan.linkerScript, 'Ld/Link.ld');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- serialConsole --------------------------------------------------------------
const { buildSerialEnv } = require('../../dist-tsc/serial/serialConsole');

test('buildSerialEnv: 参数→环境变量，eol 字符正确，多行 send 以 \\n 连接', () => {
  const env = buildSerialEnv('COM5', { baud: 9600, sendLines: ['ping', 'at+ver?'], durationSec: 7, eol: 'lf' });
  assert.strictEqual(env.MRS_TB_PORT, 'COM5');
  assert.strictEqual(env.MRS_TB_BAUD, '9600');
  assert.strictEqual(env.MRS_TB_SEND, 'ping\nat+ver?');
  assert.strictEqual(env.MRS_TB_DURATION, '7');
  assert.strictEqual(env.MRS_TB_EOL, '\n');
  const crlf = buildSerialEnv('COM3');
  assert.strictEqual(crlf.MRS_TB_BAUD, '115200');
  assert.strictEqual(crlf.MRS_TB_EOL, '\r\n');
  assert.strictEqual(crlf.MRS_TB_SEND, '');
  assert.strictEqual(crlf.MRS_TB_DURATION, '3');
});

// ---- cli/args --------------------------------------------------------------------
const { parseArgs } = require('../../dist-tsc/cli/args');

test('parseArgs: multi 旗标按短名存储、可重复、-D/--define 合并（2026-09 双串口 TX 丢失的根因）', () => {
  const a = parseArgs(['serial', '--port', 'COM4', '--send', 'hello', '--send', 'world']);
  assert.deepStrictEqual(a.multi.get('send'), ['hello', 'world'], '--send 两次累积在短名键下');
  assert.strictEqual(a.opt.get('port'), 'COM4');
  assert.strictEqual(a.multi.get('--send'), undefined, '不再以原始旗标名为键');

  const b = parseArgs(['create', '-D', 'A=1', '--define', 'B=2', '-D', 'C=3', '--search-root', 'x', '--lib', 'y']);
  assert.deepStrictEqual(b.multi.get('define'), ['A=1', 'B=2', 'C=3'], '-D 与 --define 合并到 define');
  assert.deepStrictEqual(b.multi.get('search-root'), ['x']);
  assert.deepStrictEqual(b.multi.get('lib'), ['y']);
});

test('parseArgs: 单值旗标短名规范化 + 位置参数 + 布尔旗标', () => {
  const a = parseArgs(['build', 'myproj', '-c', 'debug', '-j', '8', '-b', '9600', '--from-example', 'p']);
  assert.strictEqual(a.cmd, 'build');
  assert.deepStrictEqual(a.pos, ['myproj']);
  assert.strictEqual(a.opt.get('config'), 'debug');
  assert.strictEqual(a.opt.get('jobs'), '8');
  assert.strictEqual(a.opt.get('baud'), '9600');
  assert.strictEqual(a.opt.get('from-example'), 'p');
  assert.ok(parseArgs(['x', '--flag']).bool.has('flag'));
});

test('parseArgs: 缺值抛错', () => {
  assert.throws(() => parseArgs(['serial', '--send']), /需要一个值/);
  assert.throws(() => parseArgs(['build', '--port']), /需要一个值/);
});

// ---- bleConsole ------------------------------------------------------------------
const { buildBleEnv, parseScanLines, parseGattTable, detectBleHint } = require('../../dist-tsc/ble/bleConsole');

test('buildBleEnv: 模式/地址/发送/UUID 小写归一，多行 send 以 \\n 连接', () => {
  const env = buildBleEnv({
    mode: 'session', addr: 'AA:BB:CC:DD:EE:FF', sendLines: ['ping', 'pong'], durationSec: 9,
    serviceUuid: '6E400001-B5A3-F393-E0A9-E50E24DCCA9F',
  });
  assert.strictEqual(env.MRS_TB_MODE, 'session');
  assert.strictEqual(env.MRS_TB_ADDR, 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(env.MRS_TB_SEND, 'ping\npong');
  assert.strictEqual(env.MRS_TB_DURATION, '9');
  assert.strictEqual(env.MRS_TB_SERVICE, '6e400001-b5a3-f393-e0a9-e50e24dcca9f');
  assert.strictEqual(env.MRS_TB_CHAR, '');
  const scan = buildBleEnv({ mode: 'scan' });
  assert.strictEqual(scan.MRS_TB_DURATION, '5', '扫描默认 5 秒');
  assert.strictEqual(scan.MRS_TB_SEND, '');
  assert.strictEqual(scan.MRS_TB_ADDR, '');
});

test('parseScanLines: DEV 行解析、按 RSSI 降序、杂行忽略', () => {
  const text = [
    'DEV|AA:BB:CC:DD:EE:01|ch583_ble_uart|-52|yes',
    'LOG|radio on',
    'DEV|AA:BB:CC:DD:EE:02|-|-80|no',
    'DEV|AA:BB:CC:DD:EE:03|sanag|-61|yes',
  ].join('\r\n');
  const devs = parseScanLines(text);
  assert.deepStrictEqual(devs.map((d) => d.name), ['ch583_ble_uart', 'sanag', '-']);
  assert.strictEqual(devs[0].connectable, true);
  assert.strictEqual(devs[2].connectable, false);
  assert.strictEqual(devs[0].mac, 'AA:BB:CC:DD:EE:01');
  assert.deepStrictEqual(parseScanLines(''), []);
});

test('parseGattTable: SVC/CHR 嵌套、props 拆分、UUID 小写', () => {
  const text = [
    'LOG|connected',
    'SVC|6E400001-B5A3-F393-E0A9-E50E24DCCA9F',
    'CHR|6E400002-B5A3-F393-E0A9-E50E24DCCA9F|write-no-rsp',
    'CHR|6E400003-B5A3-F393-E0A9-E50E24DCCA9F|notify',
    'SVC|00001800-0000-1000-8000-00805f9b34fb',
    'CHR|00002a00-0000-1000-8000-00805f9b34fb|read',
  ].join('\n');
  const svcs = parseGattTable(text);
  assert.strictEqual(svcs.length, 2);
  assert.strictEqual(svcs[0].uuid, '6e400001-b5a3-f393-e0a9-e50e24dcca9f');
  assert.strictEqual(svcs[0].characteristics.length, 2);
  assert.deepStrictEqual(svcs[0].characteristics[0].props, ['write-no-rsp']);
  assert.deepStrictEqual(svcs[1].characteristics[0].props, ['read']);
});

test('detectBleHint: 蓝牙关/无适配器/不可达/无UART/订阅失败 分类', () => {
  assert.ok(/蓝牙未开启/.test(detectBleHint('ERR|RADIO_OFF|系统蓝牙未开启')));
  assert.ok(/蓝牙适配器/.test(detectBleHint('ERR|RADIO|没有蓝牙适配器')));
  assert.ok(/不可达/.test(detectBleHint('ERR|GATT|Unreachable')));
  assert.ok(/--service/.test(detectBleHint('ERR|NO_UART|未找到')));
  assert.ok(/配对/.test(detectBleHint('ERR|SUB|AccessDenied')));
  assert.strictEqual(detectBleHint('TX|hi (Success)'), undefined);
});

// ---- skillGen ------------------------------------------------------------------
const { renderExampleSkill, renderChipRef, chipRefSlug, writeExampleSkills } = require('../../dist-tsc/gen/skillGen');
// scanExampleLibrary 已在上方 exampleLibrary 段 require

function makeMiniLibrary(root) {
  const mk = (...p) => {
    const d = path.join(root, ...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const touch = (...p) => fs.closeSync(fs.openSync(path.join(root, ...p), 'w'));
  // keil 例程
  const keil = mk('CH32F103', 'EVT', 'EXAM', 'GPIO', 'Toggle');
  touch('CH32F103', 'EVT', 'EXAM', 'GPIO', 'Toggle', 'CH32F10x.uvprojx');
  touch('CH32F103', 'EVT', 'EXAM', 'GPIO', 'Toggle', 'Main.c');
  // mrs2 例程（.wvproj + User/）
  const mrs2 = mk('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle');
  touch('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle', 'Gpio_Toggle.wvproj');
  mk('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle', 'User');
  touch('CH32V00x', 'EVT', 'EXAM', 'GPIO', 'Gpio_Toggle', 'User', 'main.c');
  return { keil, mrs2 };
}

function keilPath(lib) {
  return lib.examples.find((e) => e.style === 'keil').path;
}

test('renderExampleSkill: 路由化 —— frontmatter + 芯片分表 + 形态知识 + 建工程命令', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-skill-'));
  try {
    makeMiniLibrary(root);
    const lib = scanExampleLibrary(root);
    const md = renderExampleSkill(lib, '0.0.0-test');
    assert.ok(md.startsWith('---\nname: mrs-examples-'), 'frontmatter 开头');
    assert.ok(md.includes('description: WCH 例程库'), 'description 行');
    assert.ok(md.includes(`${lib.examples.length} 个例程`), '例程计数');
    assert.ok(md.includes('芯片分表'), '分表段存在');
    assert.ok(md.includes('| CH32F103 |') && md.includes('| CH32V00x |'), '每块芯片一行分表');
    assert.ok(md.includes('`refs/ch32f103.md`') && md.includes('`refs/ch32v00x.md`'), '分表文件路径');
    assert.ok(md.indexOf('芯片分表') < md.indexOf('例程形态'), '分表在形态知识之前（截断时先看到芯片清单）');
    assert.ok(md.includes('例程形态'), '三形态知识表');
    assert.ok(md.includes('--from-example'), '建工程命令');
    assert.ok(!md.includes(keilPath(lib)), 'SKILL.md 不再内嵌例程绝对路径');

    const ref = renderChipRef('CH32F103', lib.examples.filter((e) => e.chipFolder === 'CH32F103'));
    assert.ok(ref.includes(keilPath(lib)), '分表含例程绝对路径');
    assert.ok(ref.includes('（keil）'), '分表含形态标注');
    assert.ok(ref.includes('**GPIO**'), '分表按分类分组');
    assert.strictEqual(chipRefSlug('CH32F103'), 'ch32f103');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeExampleSkills: 写入/增量同步/手改保留/陈旧清理', async () => {
  const libRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-skilllib-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-skillout-'));
  try {
    makeMiniLibrary(libRoot);
    const lib = () => scanExampleLibrary(libRoot);

    // 1) 初次生成：目录名 = mrs-examples-<库名 slug>，SKILL.md + 每芯片一个分表
    let r = await writeExampleSkills([lib()], out, '0.0.0-test');
    assert.strictEqual(r.written.length, 1);
    const skillFile = r.written[0];
    assert.ok(fs.existsSync(skillFile));
    assert.ok(path.basename(path.dirname(skillFile)).startsWith('mrs-examples-'), 'skill 目录名前缀');
    const refsDir = path.join(path.dirname(skillFile), 'refs');
    const ref103 = path.join(refsDir, 'ch32f103.md');
    const ref00x = path.join(refsDir, 'ch32v00x.md');
    assert.ok(fs.existsSync(ref103) && fs.existsSync(ref00x), '每芯片分表落盘');

    // 2) 例程新增 → 重跑分表内容更新（SKILL.md 只路由，不含例程）
    fs.mkdirSync(path.join(libRoot, 'CH32F103', 'EVT', 'EXAM', 'USART', 'Printf'), { recursive: true });
    fs.writeFileSync(path.join(libRoot, 'CH32F103', 'EVT', 'EXAM', 'USART', 'Printf', 'CH32F10x.uvprojx'), 'x');
    r = await writeExampleSkills([lib()], out, '0.0.0-test');
    assert.strictEqual(r.kept.length + r.written.length, 1);
    assert.ok(fs.readFileSync(ref103, 'utf-8').includes('Printf'), '新例程出现在芯片分表');
    assert.ok(!fs.readFileSync(r.written[0] ?? r.kept[0], 'utf-8').includes('Printf'), 'SKILL.md 路由不含例程');

    // 3) 手改单个分表（标记没了）→ 该分表保留不覆盖
    fs.writeFileSync(ref00x, 'user edited ref\n');
    r = await writeExampleSkills([lib()], out, '0.0.0-test');
    assert.strictEqual(fs.readFileSync(ref00x, 'utf-8'), 'user edited ref\n');

    // 4) 库内芯片目录消失 → 对应分表清理；用户手改的无标记分表不碰
    fs.rmSync(path.join(libRoot, 'CH32F103'), { recursive: true, force: true });
    r = await writeExampleSkills([lib()], out, '0.0.0-test');
    assert.ok(!fs.existsSync(ref103), '消失芯片的分表被清理');
    assert.ok(fs.existsSync(ref00x), '手改过的分表保留');

    // 5) SKILL.md 手改过（标记没了）→ 整库跳过
    fs.writeFileSync(skillFile, 'user edited\n');
    r = await writeExampleSkills([lib()], out, '0.0.0-test');
    assert.deepStrictEqual(r.skippedEdited, [skillFile]);
    assert.strictEqual(fs.readFileSync(skillFile, 'utf-8'), 'user edited\n');

    // 6) 库移除 → 带标记的陈旧 skill 被清理；用户自建的无标记 mrs-examples-* 不碰
    const userDir = path.join(out, 'mrs-examples-usermade');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'hand made, no marker\n');
    fs.writeFileSync(skillFile, renderExampleSkill(lib(), '0.0.0-test')); // 恢复带标记的生成内容
    r = await writeExampleSkills([], out, '0.0.0-test');
    assert.strictEqual(r.removed.length, 1, '带标记的陈旧 skill 被清理');
    assert.ok(!fs.existsSync(skillFile));
    assert.ok(fs.existsSync(path.join(userDir, 'SKILL.md')), '用户自建 skill 保留');
  } finally {
    fs.rmSync(libRoot, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---- mcuSwitcher ------------------------------------------------------------
const { switchMcu, McuSwitchError } = require('../../dist-tsc/project/mcuSwitcher');
const { extractTemplateZip } = require('../../dist-tsc/project/templateZip');
const AdmZip = require('adm-zip');

/** Synthetic template zip: same-series variants differing the way real WCH ones do. */
function makeTemplateZip(zipPath, { mcu, mcuType = 'CH58x', rom = '32K', linkerName = 'Link.ld' }) {
  const zip = new AdmZip();
  zip.addFile(
    '.template',
    Buffer.from(`Mcu Type=${mcuType}\nMCU=${mcu}\nTarget Path=obj/${mcu}.hex\nDescription=ROM(byte): ${rom}, SRAM(byte): 8K, CHIP PINS: 28\n`),
  );
  zip.addFile('.project', Buffer.from(`<name>${mcu}</name>\n`));
  zip.addFile('Ld/' + linkerName, Buffer.from(`FLASH LENGTH = ${rom}\n`));
  zip.addFile('Startup/startup_a.S', Buffer.from('.section init\n'));
  zip.addFile('src/Main.c', Buffer.from('int main(void) { for(;;); }\n'));
  zip.writeZip(zipPath);
}

function switchTestInst(seriesList, sdkRoot) {
  return {
    root: sdkRoot,
    makeBin: path.join(sdkRoot, 'make'),
    openocdExe: path.join(sdkRoot, 'openocd.exe'),
    openocdScripts: path.join(sdkRoot, 'scripts'),
    openocdRoot: sdkRoot,
    toolchains: { resolve: () => ({ name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' }) },
    chipDb: {
      series: seriesList,
      findSeries: (n) => seriesList.find((s) => s.name.toLowerCase() === n.toLowerCase()),
    },
  };
}

/** Template-created project skeleton on disk + model (the switch mutates this). */
async function makeProject(inst, series, mcuId, extraDefs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-proj-'));
  const mcu = series.mcus.find((m) => m.id === mcuId);
  extractTemplateZip(mcu.zipPath, root);
  const proj = defaultProject({
    toolchainType: 'RISC-V',
    toolchainName: 'GCC8',
    series: series.name,
    mcuId,
    mcuType: 'CH58x',
    srcDirs: ['Startup', 'src'],
    libDirs: [],
    linkerScript: 'Ld/Link.ld',
    defines: ['DEBUG=1', ...extraDefs],
    createdFrom: 'template',
  });
  return { root, proj };
}

test('mcuSwitcher: 同内存同系列切换 = 纯元数据（无文件变动）', async () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sdk-'));
  try {
    const zA = path.join(sdk, 'CH582F.zip');
    const zB = path.join(sdk, 'CH582M.zip');
    makeTemplateZip(zA, { mcu: 'CH582F' });
    makeTemplateZip(zB, { mcu: 'CH582M' }); // ROM 相同 → Link.ld 逐字节相同
    const series = {
      name: 'CH58X', type: 'RISC-V',
      isa: { arch: 'riscv', cpuFlags: '-march=rv32imac -mabi=ilp32' },
      toolchain: { name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' },
      mcuType: 'CH58x',
      mcus: [{ id: 'CH582F', zipPath: zA }, { id: 'CH582M', zipPath: zB }],
    };
    const inst = switchTestInst([series], sdk);
    const { root, proj } = await makeProject(inst, series, 'CH582F', ['CHIP_ID=CH582']);
    try {
      // 预置旧型号的调试配置，验证切换后按前缀清理
      fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(root, '.vscode', 'launch.json'),
        JSON.stringify({ version: '0.2.0', configurations: [{ name: 'MRS: Debug CH582F (cortex-debug)', type: 'cortex-debug' }] }));
      fs.mkdirSync(path.join(root, 'obj'), { recursive: true });
      fs.writeFileSync(path.join(root, 'obj', 'CH582F.hex'), 'stale');

      const r = await switchMcu(inst, root, proj, 'CH582M');
      assert.strictEqual(r.toMcuId, 'CH582M');
      assert.deepStrictEqual(r.updated, [], '不应有模板文件变动');
      assert.deepStrictEqual(r.removed, []);
      assert.deepStrictEqual(r.conflicts, []);
      assert.strictEqual(proj.mcu.mcuId, 'CH582M');
      assert.strictEqual(proj.build.targetName, 'CH582M');
      assert.strictEqual(proj.flash.image, 'obj/CH582M.hex');
      assert.ok(proj.build.defines.includes('CHIP_ID=CH582'), 'CH582F→CH582M 的 CHIP_ID 不变');
      const marker = JSON.parse(fs.readFileSync(path.join(root, '.mrs-project.json'), 'utf-8'));
      assert.strictEqual(marker.mcu.mcuId, 'CH582M');
      const makefile = fs.readFileSync(path.join(root, 'Makefile'), 'utf-8');
      assert.ok(makefile.includes('TARGET        := CH582M'));
      assert.ok(!fs.existsSync(path.join(root, 'obj')), 'obj/ 应被清空');
      const launch = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'launch.json'), 'utf-8'));
      assert.ok(!launch.configurations.some((c) => c.name.startsWith('MRS: Debug CH582F (')));
      assert.ok(launch.configurations.some((c) => c.name.startsWith('MRS: Debug CH582M (')));
      assert.ok(fs.readFileSync(path.join(root, '.project'), 'utf-8').includes('CH582M'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

test('mcuSwitcher: 内存不同 → Link.ld 被新模板覆盖', async () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sdk-'));
  try {
    const zA = path.join(sdk, 'C6.zip');
    const zB = path.join(sdk, 'C8.zip');
    makeTemplateZip(zA, { mcu: 'CH582F', rom: '32K' });
    makeTemplateZip(zB, { mcu: 'CH582M', rom: '64K' });
    const series = {
      name: 'CH58X', type: 'RISC-V',
      isa: { arch: 'riscv', cpuFlags: '-march=rv32imac -mabi=ilp32' },
      toolchain: { name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' },
      mcuType: 'CH58x',
      mcus: [{ id: 'CH582F', zipPath: zA }, { id: 'CH582M', zipPath: zB }],
    };
    const inst = switchTestInst([series], sdk);
    const { root, proj } = await makeProject(inst, series, 'CH582F');
    try {
      const r = await switchMcu(inst, root, proj, 'CH582M');
      assert.deepStrictEqual(r.updated, ['Ld/Link.ld']);
      assert.strictEqual(fs.readFileSync(path.join(root, 'Ld', 'Link.ld'), 'utf-8'), 'FLASH LENGTH = 64K\n');
      assert.strictEqual(proj.build.linkerScript, 'Ld/Link.ld', '同名链接脚本路径不变');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

test('mcuSwitcher: 用户改过的 Link.ld → 冲突保留用户版', async () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sdk-'));
  try {
    const zA = path.join(sdk, 'A.zip');
    const zB = path.join(sdk, 'B.zip');
    makeTemplateZip(zA, { mcu: 'CH582F', rom: '32K' });
    makeTemplateZip(zB, { mcu: 'CH582M', rom: '64K' });
    const series = {
      name: 'CH58X', type: 'RISC-V',
      isa: { arch: 'riscv', cpuFlags: '-march=rv32imac -mabi=ilp32' },
      toolchain: { name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' },
      mcuType: 'CH58x',
      mcus: [{ id: 'CH582F', zipPath: zA }, { id: 'CH582M', zipPath: zB }],
    };
    const inst = switchTestInst([series], sdk);
    const { root, proj } = await makeProject(inst, series, 'CH582F');
    try {
      const custom = 'FLASH LENGTH = 15K /* 用户裁剪: 15K+1KB 布局 */\n';
      fs.writeFileSync(path.join(root, 'Ld', 'Link.ld'), custom);
      const r = await switchMcu(inst, root, proj, 'CH582M');
      assert.ok(r.conflicts.includes('Ld/Link.ld'));
      assert.strictEqual(fs.readFileSync(path.join(root, 'Ld', 'Link.ld'), 'utf-8'), custom, '用户版必须原样保留');
      // 元数据仍然切换成功
      assert.strictEqual(proj.mcu.mcuId, 'CH582M');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

test('mcuSwitcher: 每型号一个 .ld 文件名（F103 式）→ 换名 + 重定位 linkerScript', async () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sdk-'));
  try {
    const zA = path.join(sdk, 'A.zip');
    const zB = path.join(sdk, 'B.zip');
    makeTemplateZip(zA, { mcu: 'CH582F', rom: '32K', linkerName: 'AA1.ld' });
    makeTemplateZip(zB, { mcu: 'CH582M', rom: '64K', linkerName: 'BB1.ld' });
    const series = {
      name: 'CH58X', type: 'RISC-V',
      isa: { arch: 'riscv', cpuFlags: '-march=rv32imac -mabi=ilp32' },
      toolchain: { name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' },
      mcuType: 'CH58x',
      mcus: [{ id: 'CH582F', zipPath: zA }, { id: 'CH582M', zipPath: zB }],
    };
    const inst = switchTestInst([series], sdk);
    const { root, proj } = await makeProject(inst, series, 'CH582F');
    proj.build.linkerScript = 'Ld/AA1.ld';
    try {
      const r = await switchMcu(inst, root, proj, 'CH582M');
      assert.ok(r.updated.includes('Ld/BB1.ld'));
      assert.ok(r.removed.includes('Ld/AA1.ld'));
      assert.ok(!fs.existsSync(path.join(root, 'Ld', 'AA1.ld')));
      assert.strictEqual(proj.build.linkerScript, 'Ld/BB1.ld');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

test('mcuSwitcher: 例程工程剥离过的模板 main 不复活', async () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sdk-'));
  try {
    const zA = path.join(sdk, 'A.zip');
    const zB = path.join(sdk, 'B.zip');
    makeTemplateZip(zA, { mcu: 'CH582F', rom: '32K' });
    makeTemplateZip(zB, { mcu: 'CH582M', rom: '64K' });
    const series = {
      name: 'CH58X', type: 'RISC-V',
      isa: { arch: 'riscv', cpuFlags: '-march=rv32imac -mabi=ilp32' },
      toolchain: { name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' },
      mcuType: 'CH58x',
      mcus: [{ id: 'CH582F', zipPath: zA }, { id: 'CH582M', zipPath: zB }],
    };
    const inst = switchTestInst([series], sdk);
    const { root, proj } = await makeProject(inst, series, 'CH582F');
    fs.rmSync(path.join(root, 'src', 'Main.c')); // 例程工程剥掉了模板 main
    try {
      const r = await switchMcu(inst, root, proj, 'CH582M');
      assert.ok(!r.updated.includes('src/Main.c'));
      assert.ok(!fs.existsSync(path.join(root, 'src', 'Main.c')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

test('mcuSwitcher: CHIP_ID 随型号变化（CH582F→CH583M）', async () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sdk-'));
  try {
    const zA = path.join(sdk, 'A.zip');
    const zB = path.join(sdk, 'B.zip');
    makeTemplateZip(zA, { mcu: 'CH582F' });
    makeTemplateZip(zB, { mcu: 'CH583M' });
    const series = {
      name: 'CH58X', type: 'RISC-V',
      isa: { arch: 'riscv', cpuFlags: '-march=rv32imac -mabi=ilp32' },
      toolchain: { name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' },
      mcuType: 'CH58x',
      mcus: [{ id: 'CH582F', zipPath: zA }, { id: 'CH583M', zipPath: zB }],
    };
    const inst = switchTestInst([series], sdk);
    const { root, proj } = await makeProject(inst, series, 'CH582F', ['CHIP_ID=CH582']);
    try {
      await switchMcu(inst, root, proj, 'CH583M');
      assert.ok(proj.build.defines.includes('CHIP_ID=CH583'), 'CHIP_ID 必须替换为 CH583');
      assert.ok(!proj.build.defines.includes('CHIP_ID=CH582'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

test('mcuSwitcher: 跨系列 / 特殊型号 / 原型号 → 拒绝', async () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sdk-'));
  try {
    const zA = path.join(sdk, 'A.zip');
    const zB = path.join(sdk, 'B.zip');
    const zC = path.join(sdk, 'C.zip'); // Mcu Type 不同的特殊型号
    makeTemplateZip(zA, { mcu: 'CH582F' });
    makeTemplateZip(zB, { mcu: 'CH582M' });
    makeTemplateZip(zC, { mcu: 'CH582Q', mcuType: 'CH58y' });
    const s1 = {
      name: 'CH58X', type: 'RISC-V',
      isa: { arch: 'riscv', cpuFlags: '-march=rv32imac -mabi=ilp32' },
      toolchain: { name: 'GCC8', type: 'RISC-V', binDir: 'C:/fake/bin', prefix: 'riscv-none-embed-' },
      mcuType: 'CH58x',
      mcus: [{ id: 'CH582F', zipPath: zA }, { id: 'CH582M', zipPath: zB }, { id: 'CH582Q', zipPath: zC }],
    };
    const s2 = { ...s1, name: 'OTHER', mcus: [{ id: 'CH999', zipPath: zA }] };
    const inst = switchTestInst([s1, s2], sdk);
    const { root, proj } = await makeProject(inst, s1, 'CH582F');
    try {
      await assert.rejects(() => switchMcu(inst, root, proj, 'CH999'), McuSwitchError); // 跨系列
      await assert.rejects(() => switchMcu(inst, root, proj, 'CH582Q'), McuSwitchError); // 外设库类型不同
      await assert.rejects(() => switchMcu(inst, root, proj, 'CH582F'), McuSwitchError); // 原型号
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true });
  }
});

// ---- run --------------------------------------------------------------------
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failures++;
      console.error(`  [FAIL] ${name}\n         ${e.message}`);
    }
  }
  console.log(`== ${failures === 0 ? tests.length + ' PASS' : failures + ' FAILURES'} ==`);
  process.exit(failures === 0 ? 0 : 1);
})();
