import * as vscode from 'vscode';
import * as path from 'path';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';
import { readJsonIfExists, writeIfChanged, toPosix } from '../util/fsx';

/**
 * Generates `.vscode/launch.json` (cortex-debug + cppdbg variants) and the
 * `.vscode/tasks.json` openocd background server task used as cppdbg's
 * preLaunchTask. Invocation parameters mirror what MRS2 itself uses
 * (extracted from template `.launch` files).
 */
export async function generateDebugConfigs(
  projRoot: string,
  proj: MrsProject,
  inst: MrsInstallation,
): Promise<void> {
  const series = inst.chipDb.findSeries(proj.mcu.series);
  const isRiscv = proj.mcu.toolchainType === 'RISC-V';
  const toolchain = inst.toolchains.resolve(proj.mcu.toolchainName);
  if (!toolchain) {
    throw new Error(`toolchain ${proj.mcu.toolchainName} not resolved`);
  }

  const gdb = toPosix(path.join(toolchain.binDir, toolchain.prefix + 'gdb.exe'));
  const openocdExe = toPosix(inst.openocdExe);
  const openocdScripts = toPosix(inst.openocdScripts);
  const openocdCfg = toPosix(
    path.join(inst.openocdRoot, 'bin', isRiscv ? 'wch-riscv.cfg' : 'wch-arm.cfg'),
  );
  const svd = series?.svdPath ? toPosix(series.svdPath) : undefined;
  const elf = `\${workspaceFolder}/${toPosix(proj.build.outputDir)}/${proj.build.targetName}.elf`;
  const stopAt = proj.debug.stopAt || (isRiscv ? 'handle_reset' : 'main');

  const settings = vscode.workspace.getConfiguration('mrsToolbox');
  const gdbPort = settings.get<number>('openocd.gdbPort', 3333);
  const telnetPort = settings.get<number>('openocd.telnetPort', 4444);
  const tclPort = settings.get<number>('openocd.tclPort', 6666);

  const gdbSetup = [
    'set mem inaccessible-by-default off',
    ...(isRiscv ? ['set architecture riscv:rv32'] : []),
    'set remotetimeout unlimited',
  ];

  // Port overrides from settings (defaults match the wch-*.cfg files).
  const portArgs: string[] = [];
  if (gdbPort !== 3333) {
    portArgs.push('-c', `gdb_port ${gdbPort}`);
  }
  if (telnetPort !== 4444) {
    portArgs.push('-c', `telnet_port ${telnetPort}`);
  }
  if (tclPort !== 6666) {
    portArgs.push('-c', `tcl_port ${tclPort}`);
  }

  const cortexDebug = {
    name: `MRS: Debug ${proj.build.targetName} (cortex-debug)`,
    type: 'cortex-debug',
    request: 'launch',
    cwd: '${workspaceFolder}',
    executable: elf,
    servertype: 'openocd',
    serverpath: openocdExe,
    searchDirectory: [openocdScripts],
    configFiles: [openocdCfg],
    ...(portArgs.length ? { serverArgs: portArgs } : {}),
    gdbPath: gdb,
    ...(svd ? { svdFile: svd } : {}),
    runToEntryPoint: stopAt,
    overrideLaunchCommands: [...gdbSetup, 'monitor reset init', 'load', `break ${stopAt}`, 'continue'],
    preLaunchTask: 'MRS Toolbox: Build',
  };

  const cppdbg = {
    name: `MRS: Debug ${proj.build.targetName} (cpptools)`,
    type: 'cppdbg',
    request: 'launch',
    cwd: '${workspaceFolder}',
    program: elf,
    MIMode: 'gdb',
    miDebuggerPath: gdb,
    miDebuggerServerAddress: `localhost:${gdbPort}`,
    setupCommands: [
      ...gdbSetup.map((text) => ({ text })),
      { text: 'monitor reset init' },
      { text: 'load' },
      { text: `tbreak ${stopAt}` },
      { text: 'continue' },
    ],
    preLaunchTask: 'MRS Toolbox: OpenOCD Server',
  };

  await mergeJsonList(path.join(projRoot, '.vscode', 'launch.json'), 'configurations', [
    cortexDebug,
    cppdbg,
  ]);

  const openocdServerTask = {
    label: 'MRS Toolbox: OpenOCD Server',
    type: 'process',
    command: openocdExe,
    args: ['-s', openocdScripts, '-f', openocdCfg, ...portArgs],
    isBackground: true,
    problemMatcher: {
      owner: 'mrs-toolbox-openocd',
      pattern: { regexp: '^(?!x)x$', file: 1, line: 2, message: 3 },
      background: {
        activeOnStart: true,
        beginsPattern: 'Open On-Chip Debugger',
        endsPattern: 'Listening on port \\d+ for gdb connections',
      },
    },
  };
  await mergeJsonList(path.join(projRoot, '.vscode', 'tasks.json'), 'tasks', [openocdServerTask]);
}

interface JsonListFile {
  version?: number;
  [key: string]: unknown;
}

/** Merge entries into a JSON file that holds a list under `listKey` (launch/tasks). */
async function mergeJsonList(file: string, listKey: string, entries: Record<string, unknown>[]): Promise<void> {
  let doc = (await readJsonIfExists<JsonListFile>(file)) ?? { version: 0.2 };
  const list = ((doc[listKey] as Record<string, unknown>[]) ?? []);
  const byNameKey = listKey === 'configurations' ? 'name' : 'label';
  for (const entry of entries) {
    const idx = list.findIndex((e) => e[byNameKey] === entry[byNameKey]);
    if (idx >= 0) {
      list[idx] = entry;
    } else {
      list.push(entry);
    }
  }
  doc = { ...doc, [listKey]: list };
  await writeIfChanged(file, JSON.stringify(doc, null, 2) + '\n');
}
