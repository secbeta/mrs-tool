import * as vscode from 'vscode';
import * as path from 'path';
import type { MrsProject } from '../project/projectModel';
import type { MrsInstallation } from '../locator/mrsInstallation';
import { toPosix, writeIfChanged } from '../util/fsx';

/**
 * Generates `.vscode/c_cpp_properties.json` using the resolved toolchain
 * compiler and the include directories discovered for the Makefile.
 */
export async function generateIntellisense(
  projRoot: string,
  proj: MrsProject,
  inst: MrsInstallation,
): Promise<void> {
  const toolchain = inst.toolchains.resolve(proj.mcu.toolchainName);
  const series = inst.chipDb.findSeries(proj.mcu.series);
  if (!toolchain) {
    throw new Error(`toolchain ${proj.mcu.toolchainName} not found in MRS2`);
  }

  const gccPath = path.join(toolchain.binDir, toolchain.prefix + 'gcc.exe');

  // Header dirs mirror the Makefile's recursive scan over srcDirs + libDirs.
  const headerDirs = new Set<string>(['${workspaceFolder}']);
  for (const dir of [...proj.build.srcDirs, ...proj.build.libDirs]) {
    await collectHeaderDirs(path.join(projRoot, dir), dir, headerDirs);
  }
  for (const extra of proj.build.extraIncludes) {
    headerDirs.add(
      /^[a-zA-Z]:|^\/|^$\{workspaceFolder\}/.test(extra) ? extra : `\${workspaceFolder}/${toPosix(extra)}`,
    );
  }

  const config = {
    version: 4,
    configurations: [
      {
        name: 'MRS Toolbox',
        compilerPath: toPosix(gccPath),
        compilerArgs: series ? series.isa.cpuFlags.split(' ') : [],
        intelliSenseMode: proj.mcu.toolchainType === 'ARM' ? 'gcc-arm' : '${default}',
        defines: proj.build.defines.filter((d) => !d.includes('(')),
        includePath: [...headerDirs],
        cStandard: mapCStandard(proj.build.cStd),
        cppStandard: proj.build.cxxStd === 'gnu++14' ? 'c++14' : 'c++17',
      },
    ],
  };

  const target = path.join(projRoot, '.vscode', 'c_cpp_properties.json');
  const existing = await vscode.workspace.fs
    .readFile(vscode.Uri.file(target))
    .then((b) => Buffer.from(b).toString('utf-8'), () => undefined);
  if (existing) {
    try {
      const parsed = JSON.parse(stripComments(existing));
      if (parsed.configurations?.some((c: { name: string }) => c.name === 'MRS Toolbox')) {
        parsed.configurations = parsed.configurations.map((c: { name: string }) =>
          c.name === 'MRS Toolbox' ? config.configurations[0] : c,
        );
        await writeIfChanged(target, JSON.stringify(parsed, null, 2) + '\n');
        return;
      }
      parsed.configurations.push(config.configurations[0]);
      await writeIfChanged(target, JSON.stringify(parsed, null, 2) + '\n');
      return;
    } catch {
      /* unparsable — fall through and overwrite */
    }
  }
  await writeIfChanged(target, JSON.stringify(config, null, 2) + '\n');
}

function mapCStandard(std: string): string {
  switch (std) {
    case 'c99':
    case 'gnu99':
      return 'c99';
    case 'c11':
    case 'gnu11':
      return 'c11';
    default:
      return 'c99';
  }
}

async function collectHeaderDirs(absDir: string, relDir: string, out: Set<string>): Promise<void> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await vscode.workspace.fs
      .readDirectory(vscode.Uri.file(absDir))
      .then((r) => r.map(([name, type]) => ({ name, isDirectory: () => type === vscode.FileType.Directory })));
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      await collectHeaderDirs(path.join(absDir, e.name), rel, out);
    } else if (e.name.endsWith('.h')) {
      out.add(`\${workspaceFolder}/${toPosix(relDir)}`);
    }
  }
}

function stripComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}
