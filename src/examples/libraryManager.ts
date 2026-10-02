import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { scanExampleLibrary, type ExampleLibrary } from './exampleLibrary';

const SECTION = 'mrsToolbox';
const ARRAY_KEY = 'examplesDirectories';
const LEGACY_KEY = 'examplesDirectory';

/**
 * Multiple example libraries (like ESP-IDF's IDF/ADF installs): the
 * `examplesDirectories` array setting is merged with the legacy single
 * `examplesDirectory` setting, deduplicated case-insensitively.
 */
export function libraryDirs(): string[] {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const arr = cfg.get<string[]>(ARRAY_KEY, []);
  const legacy = cfg.get<string>(LEGACY_KEY, '');
  const out: string[] = [];
  for (const d of [...arr, legacy]) {
    if (d && !out.some((x) => x.toLowerCase() === d.toLowerCase())) {
      out.push(d);
    }
  }
  return out;
}

/** Scan every configured library (nonexistent roots yield 0 examples). */
export function scanAllLibraries(): ExampleLibrary[] {
  return libraryDirs().map(scanExampleLibrary);
}

/** How many recognizable examples live under a candidate directory. */
export function scanCount(dir: string): number {
  return scanExampleLibrary(dir).examples.length;
}

export function libraryLabel(dir: string): string {
  return path.basename(dir) || dir;
}

export function libraryExists(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

/** Persist the array of library dirs at user scope (survives all workspaces). */
async function writeDirs(dirs: string[]): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(ARRAY_KEY, dirs, vscode.ConfigurationTarget.Global);
}

export async function addLibraryDir(dir: string): Promise<void> {
  const dirs = libraryDirs();
  if (!dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) {
    dirs.push(dir);
    await writeDirs(dirs);
  }
}

export async function removeLibraryDir(dir: string): Promise<void> {
  const dirs = libraryDirs().filter((d) => d.toLowerCase() !== dir.toLowerCase());
  await writeDirs(dirs);
  // Clear the legacy single-dir setting too when it pointed at the removed dir,
  // so it does not resurrect (its default is a machine-specific path).
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const legacy = cfg.get<string>(LEGACY_KEY, '');
  if (legacy && legacy.toLowerCase() === dir.toLowerCase()) {
    await cfg.update(LEGACY_KEY, '', vscode.ConfigurationTarget.Global);
  }
}
