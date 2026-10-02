import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_MARKER, PROJECT_SCHEMA_VERSION } from '../constants';
import { pathExists, pathExistsSync, readJsonIfExists, writeIfChanged } from '../util/fsx';

export interface MrsProject {
  version: number;
  mcu: {
    vendor: string;
    toolchainType: 'RISC-V' | 'ARM';
    toolchainName: string;
    series: string;
    mcuId: string;
    mcuType: string;
  };
  build: {
    targetName: string;
    outputDir: string;
    srcDirs: string[];
    libDirs: string[];
    linkerScript: string;
    defines: string[];
    /** Project-relative paths kept out of the build (files or whole dirs). */
    excludedPaths: string[];
    extraIncludes: string[];
    cStd: string;
    cxxStd: string;
    debugOpt: string;
    releaseOpt: string;
    cFlagsExtra: string[];
    cxxFlagsExtra: string[];
    asFlagsExtra: string[];
    ldFlagsExtra: string[];
    generateHex: boolean;
    generateBin: boolean;
    generateListing: boolean;
  };
  flash: {
    image: string;
    address: string;
    eraseMode: 'chip-default' | 'sectors-only';
    verify: boolean;
    resetRun: boolean;
  };
  debug: {
    openocdConfig: string;
    stopAt: string;
    svd: string;
  };
  templateInfo: {
    sdkVersion?: string;
    peripheralVersion?: string;
    createdFrom: 'template' | 'example' | 'import';
    examplePath?: string;
  };
  /** Preserved unknown fields (forward compatibility). */
  [key: string]: unknown;
}

/** Default project skeleton for a given series/MCU; wizard layers edits on top. */
export function defaultProject(input: {
  toolchainType: 'RISC-V' | 'ARM';
  toolchainName: string;
  series: string;
  mcuId: string;
  mcuType: string;
  srcDirs: string[];
  libDirs: string[];
  linkerScript: string;
  defines: string[];
  excludedPaths?: string[];
  createdFrom: 'template' | 'example' | 'import';
  examplePath?: string;
  sdkVersion?: string;
}): MrsProject {
  return {
    version: PROJECT_SCHEMA_VERSION,
    mcu: {
      vendor: 'WCH',
      toolchainType: input.toolchainType,
      toolchainName: input.toolchainName,
      series: input.series,
      mcuId: input.mcuId,
      mcuType: input.mcuType,
    },
    build: {
      targetName: input.mcuId,
      outputDir: 'obj',
      srcDirs: input.srcDirs,
      libDirs: input.libDirs,
      linkerScript: input.linkerScript,
      defines: input.defines,
      excludedPaths: input.excludedPaths ?? [],
      extraIncludes: [],
      cStd: 'gnu99',
      cxxStd: 'gnu++14',
      debugOpt: '-Og',
      releaseOpt: '-Os',
      cFlagsExtra: [],
      cxxFlagsExtra: [],
      asFlagsExtra: [],
      ldFlagsExtra: [],
      generateHex: true,
      generateBin: true,
      generateListing: true,
    },
    flash: {
      image: `obj/${input.mcuId}.hex`,
      address: '0x00000000',
      eraseMode: 'chip-default',
      verify: true,
      resetRun: true,
    },
    debug: {
      openocdConfig: 'auto',
      stopAt: input.toolchainType === 'RISC-V' ? 'handle_reset' : 'main',
      svd: 'auto',
    },
    templateInfo: {
      sdkVersion: input.sdkVersion,
      peripheralVersion: undefined,
      createdFrom: input.createdFrom,
      examplePath: input.examplePath,
    },
  };
}

export async function loadProject(root: string): Promise<MrsProject | undefined> {
  // Marker presence is enough; structural problems surface in the wizard/commands.
  return readJsonIfExists<MrsProject>(path.join(root, PROJECT_MARKER));
}

export function validate(root: string, proj: MrsProject): string | undefined {
  if (!proj?.mcu?.series || !proj?.mcu?.mcuId) {
    return 'missing mcu section';
  }
  const b = proj.build;
  if (!b || !Array.isArray(b.srcDirs) || b.srcDirs.length === 0) {
    return 'build.srcDirs must be a non-empty array';
  }
  if (!b.linkerScript) {
    return 'build.linkerScript missing';
  }
  return undefined;
}

export async function saveProject(root: string, proj: MrsProject): Promise<void> {
  await writeIfChanged(path.join(root, PROJECT_MARKER), JSON.stringify(proj, null, 2) + '\n');
}

/**
 * Find project roots in the workspace (marker file present). Projects may sit
 * directly at a workspace-folder root or nested anywhere below it (a "repo"
 * workspace holding repo/fw/demo) — scan depth-bounded and stop descending
 * once a folder IS a project (projects never nest). Read-only traversal;
 * folders without the marker are never touched.
 */
export async function findWorkspaceProjects(maxDepth = 4): Promise<string[]> {
  const SKIP_DIRS = new Set(['node_modules', 'obj']);
  const roots: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await pathExists(path.join(folder.uri.fsPath, PROJECT_MARKER))) {
      roots.push(folder.uri.fsPath);
      continue;
    }
    roots.push(...scanForMarkers(folder.uri.fsPath, maxDepth, SKIP_DIRS));
  }
  return roots.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function scanForMarkers(dir: string, depth: number, skip: Set<string>): string[] {
  const out: string[] = [];
  if (depth <= 0) {
    return out;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith('.')) {
      continue;
    }
    const child = path.join(dir, e.name);
    if (pathExistsSync(path.join(child, PROJECT_MARKER))) {
      out.push(child);
    } else {
      out.push(...scanForMarkers(child, depth - 1, skip));
    }
  }
  return out;
}
