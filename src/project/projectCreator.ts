import * as fs from 'fs';
import * as path from 'path';
import type { MrsInstallation } from '../locator/mrsInstallation';
import { renderMakefile } from '../gen/makefileGen';
import { generateIntellisense } from '../gen/intellisenseGen';
import { syncCproject } from '../gen/cprojectGen';
import { defaultProject, saveProject, type MrsProject } from './projectModel';
import { extractTemplateZip, topSourceDirs } from './templateZip';
import { scanProject, suggestChipDefine } from './projectScanner';
import { parseProjectFile } from '../examples/cprojectParser';
import { writeIfChanged } from '../util/fsx';
import { writeAgentDocs } from '../cli/agentDocs';
import { EXAMPLE_SERIES_MAP } from '../constants';
import type { SeriesInfo } from '../chipdb/types';

const SKIP_COPY = new Set(['obj', '.settings', '.vscode']);
const SKIP_FILES = new Set([
  '.cproject',
  '.project',
  '.launch',
  '.template',
  '.wvproj',
  '.uvprojx',
  '.uvproj',
  '.cvproject',
]);

export interface CreateOptions {
  series: SeriesInfo;
  mcuId: string;
  /** Destination folder (created if missing). */
  destDir: string;
  createdFrom: 'template' | 'example' | 'import';
  /** Example folder (createdFrom=example). */
  exampleDir?: string;
  /** Roots searched for shared source pools when importing a bare example copy. */
  searchRoots?: string[];
  /** Extra defines layered on top of the defaults. */
  extraDefines?: string[];
}

/** Copy a directory tree, skipping IDE/build files — returns copied dest files. */
function copyTree(src: string, dest: string): string[] {
  const copied: string[] = [];
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.has(e.name)) {
      continue;
    }
    if (e.isFile() && SKIP_FILES.has(e.name)) {
      continue;
    }
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      copied.push(...copyTree(s, d));
    } else if (e.isFile()) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      copied.push(d);
    }
  }
  return copied;
}

function findFilesRecursive(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) {
      return;
    }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_COPY.has(e.name) && !e.name.startsWith('.')) {
          walk(path.join(d, e.name), depth + 1);
        }
      } else if (exts.includes(path.extname(e.name).toLowerCase())) {
        out.push(path.join(d, e.name));
      }
    }
  };
  try {
    walk(dir, 0);
  } catch {
    /* unreadable */
  }
  return out;
}

export function findLinkerScript(root: string): string | undefined {
  const lds = findFilesRecursive(root, ['.ld', '.lds']);
  return (
    lds.find((p) => /ld\//i.test(path.relative(root, p))) ??
    lds.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0]
  );
}

function dirsContaining(root: string, exts: string[], dirs: string[]): string[] {
  return dirs.filter((d) => findFilesRecursive(path.join(root, d), exts).length > 0);
}

function collectSrcDirs(root: string): string[] {
  // All top dirs that contain compilable sources (deep), minus pure linker dirs.
  return topSourceDirs(root).filter(
    (d) => findFilesRecursive(path.join(root, d), ['.c', '.cpp', '.cc', '.s']).length > 0,
  );
}

/**
 * Unified creation entry. The recipe is always: materialize sources into
 * `destDir` (template zip ∪ example overlay ∪ already present for import),
 * derive build inputs by scanning, then write marker + Makefile + configs.
 */
export async function createProject(
  inst: MrsInstallation,
  opts: CreateOptions,
): Promise<MrsProject> {
  const { series, mcuId, destDir } = opts;
  const mcu = series.mcus.find((m) => m.id === mcuId);
  if (!mcu) {
    throw new Error(`MCU ${mcuId} not found in series ${series.name}`);
  }
  fs.mkdirSync(destDir, { recursive: true });

  const extraDefines = [...(opts.extraDefines ?? [])];

  if (opts.createdFrom === 'template') {
    extractTemplateZip(mcu.zipPath, destDir);
  } else if (opts.createdFrom === 'example' && opts.exampleDir) {
    createFromExample(
      opts.exampleDir,
      mcu.zipPath,
      destDir,
      extraDefines,
      opts.searchRoots ?? [],
      opts.series.name,
      opts.mcuId,
    );
  } else if (opts.createdFrom === 'import') {
    importExisting(destDir, mcu.zipPath, opts.searchRoots ?? [], opts.series.name, opts.mcuId);
  }

  const scanned = scanProject(destDir);
  let srcDirs = collectSrcDirs(destDir);
  if (srcDirs.length === 0 && scanned.srcDirs.length > 0) {
    srcDirs = scanned.srcDirs;
  }
  const libDirs = dirsContaining(
    destDir,
    ['.a'],
    fs.readdirSync(destDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  );
  const linkerAbs = findLinkerScript(destDir);
  const linkerRel = linkerAbs
    ? path.relative(destDir, linkerAbs).split(path.sep).join('/')
    : undefined;
  if (!linkerRel) {
    throw new Error(`no linker script (.ld) found under ${destDir}`);
  }

  const defines = dedupe(['DEBUG=1', ...projectDefines(opts, destDir), ...extraDefines]);
  const chipDefine = suggestChipDefine(mcuId, series.name);
  if (chipDefine && !defines.some((d) => d.startsWith('CHIP_ID='))) {
    defines.push(chipDefine);
  }

  // Build exclusions from the origin Eclipse project (example dir / imported
  // root): the four mutually-exclusive BLE service variants etc.
  const originDir =
    opts.createdFrom === 'example' && opts.exampleDir
      ? opts.exampleDir
      : opts.createdFrom === 'import'
        ? destDir
        : undefined;
  const excludedPaths = originDir ? parseProjectFile(originDir).excludedPaths : [];

  const proj = defaultProject({
    toolchainType: series.type,
    toolchainName: series.toolchain.name,
    series: series.name,
    mcuId,
    mcuType: series.mcuType ?? mcuId,
    srcDirs,
    libDirs,
    linkerScript: linkerRel,
    defines,
    excludedPaths,
    createdFrom: opts.createdFrom,
    examplePath: opts.exampleDir,
    sdkVersion: inst.chipDb.sdk.version,
  });

  await finalizeProject(inst, destDir, proj);
  return proj;
}

/** Defines from the origin project's .cproject (example dir or imported root). */
function projectDefines(opts: CreateOptions, destDir: string): string[] {
  if (opts.createdFrom === 'example' && opts.exampleDir) {
    return parseProjectFile(opts.exampleDir).defines;
  }
  if (opts.createdFrom === 'import') {
    return parseProjectFile(destDir).defines;
  }
  return [];
}

/**
 * Import in place: make the folder self-contained.
 * 1. pull Eclipse-linked folders that still resolve (in-place imports),
 * 2. for links broken by a bare copy (PARENT-n paths pointing nowhere), look
 *    for the same folder somewhere under searchRoots (the examples library),
 *    preferring matches under a chip folder consistent with the series/MCU,
 * 3. if the linker script is still missing, fill gaps from the SDK template
 *    zip (any top dir not already present, minus User/ to avoid a main() clash).
 */
function importExisting(
  destDir: string,
  zipPath: string,
  searchRoots: string[],
  seriesName: string,
  mcuId: string,
): void {
  pullLinkedFolders(destDir, destDir, searchRoots, seriesName, mcuId);
  if (!findLinkerScript(destDir)) {
    extractMissingTemplateDirs(zipPath, destDir);
  }
}

/**
 * Copy Eclipse-linked external folders into `destDir` under their virtual
 * name. Links whose PARENT-n target no longer resolves (a bare copy of the
 * example) are looked up under `searchRoots` (the examples libraries),
 * biased toward chip-family folder names.
 */
function pullLinkedFolders(
  srcDir: string,
  destDir: string,
  searchRoots: string[],
  seriesName: string,
  mcuId: string,
): void {
  const info = parseProjectFile(srcDir);
  for (const link of info.linkedFolders) {
    copyLinked(destDir, link.name, link.absPath);
  }
  const bias = chipPathTerms(seriesName, mcuId);
  for (const u of info.unresolvedLinks) {
    const tail = u.uri.replace(/^PARENT-\d+-PROJECT_LOC\/?/i, '');
    if (!tail) {
      continue;
    }
    for (const root of searchRoots) {
      const found = findDirByTail(root, tail, bias);
      if (found) {
        copyLinked(destDir, u.name, found);
        break;
      }
    }
  }
}

/** Folder-name terms identifying "this path belongs to our chip family". */
function chipPathTerms(seriesName: string, mcuId: string): Set<string> {
  const terms = new Set<string>([seriesName, mcuId, mcuId.replace(/[A-Z]+$/, '')]);
  for (const [folder, mapping] of Object.entries(EXAMPLE_SERIES_MAP)) {
    if (mapping.series.toUpperCase() === seriesName.toUpperCase()) {
      terms.add(folder);
    }
  }
  return terms;
}

function copyLinked(destDir: string, name: string, absPath: string): void {
  const target = path.join(destDir, name);
  if (!fs.existsSync(target)) {
    copyTree(absPath, target);
  }
}

/**
 * Find a directory whose path ends with `a/b` (e.g. `SRC/Ld`), depth-bounded.
 * Among all matches, prefer one under a folder named in `bias` (chip-family
 * terms) so a CH583 example doesn't pull CH32F103's StdPeriphDriver.
 */
function findDirByTail(root: string, tail: string, bias: Set<string>): string | undefined {
  const wanted = tail.split('/').filter(Boolean).map((s) => s.toLowerCase());
  const matches: string[] = [];
  const skip = new Set(['obj', '.git', '.vscode', '.settings']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) {
        continue;
      }
      const p = path.join(dir, e.name);
      const parts = p.split(/[\\/]+/).map((s) => s.toLowerCase());
      const last = parts.slice(-wanted.length);
      if (last.length === wanted.length && last.every((seg, i) => seg === wanted[i])) {
        matches.push(p);
      }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return (
    matches.find((m) =>
      m
        .split(/[\\/]+/)
        .some((seg) => bias.has(seg) || [...bias].some((t) => t.toLowerCase() === seg)),
    ) ?? matches[0]
  );
}

/** Extract the template zip and move in only top-level dirs that are missing. */
function extractMissingTemplateDirs(zipPath: string, destDir: string): void {
  const tmp = path.join(destDir, '.mrs-template-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  extractTemplateZip(zipPath, tmp);
  try {
    for (const e of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'User') {
        continue;
      }
      const target = path.join(destDir, e.name);
      if (!fs.existsSync(target)) {
        fs.renameSync(path.join(tmp, e.name), target);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Example overlay onto the SDK template base:
 * 1. extract template zip (Core/Peripheral/Startup/Ld/User…),
 * 2. copy example sources (skipping IDE files and obj/),
 * 3. pull Eclipse-linked external folders (e.g. CH583 `SRC/StdPeriphDriver`),
 * 4. remove template app files whose main() clashes with the example's,
 * 5. merge defines parsed from the example's .cproject.
 */
function createFromExample(
  exampleDir: string,
  zipPath: string,
  destDir: string,
  extraDefines: string[],
  searchRoots: string[],
  seriesName: string,
  mcuId: string,
): void {
  extractTemplateZip(zipPath, destDir);
  const keep = new Set(copyTree(exampleDir, destDir));

  // Eclipse linked folders (CH583 `../HAL`, `SRC/StdPeriphDriver`, …) → copy
  // them in under their virtual name so the result is self-contained.
  pullLinkedFolders(exampleDir, destDir, searchRoots, seriesName, mcuId);

  // Keil-style flat examples: app .c/.h files directly in the example root.
  const flat = fs
    .readdirSync(exampleDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(c|h)$/i.test(e.name))
    .map((e) => e.name);
  if (flat.length > 0) {
    const userDir = path.join(destDir, 'User');
    fs.mkdirSync(userDir, { recursive: true });
    for (const f of flat) {
      const d = path.join(userDir, f);
      fs.copyFileSync(path.join(exampleDir, f), d);
      keep.add(d);
    }
  }

  stripClashingMains(destDir, keep);
  extraDefines.push(...parseProjectFile(exampleDir).defines);
}

/**
 * The template base ships its own app entry (e.g. CH58X `src/Main.c`); when
 * the example provides main() elsewhere, delete the template's copy so the
 * link doesn't see two mains.
 */
function stripClashingMains(destDir: string, keep: Set<string>): void {
  const all = findFilesRecursive(destDir, ['.c']);
  const mains = all.filter(definesMain);
  if (!mains.some((f) => keep.has(f))) {
    return;
  }
  for (const f of mains) {
    if (!keep.has(f)) {
      fs.rmSync(f);
    }
  }
}

function definesMain(file: string): boolean {
  try {
    return /\b(?:int|void)\s+main\s*\(/.test(fs.readFileSync(file, 'utf-8'));
  } catch {
    return false;
  }
}

/** Write marker + Makefile + IntelliSense config (+ .gitignore + agent docs). */
export async function finalizeProject(
  inst: MrsInstallation,
  projRoot: string,
  proj: MrsProject,
): Promise<void> {
  await saveProject(projRoot, proj);
  await writeIfChanged(path.join(projRoot, 'Makefile'), renderMakefile(proj, inst));
  // Keep the Eclipse .cproject aligned with the model so MRS2-side builds
  // (which read .cproject, not our Makefile) see the same includes/defines.
  await syncCproject(projRoot, proj);
  await generateIntellisense(projRoot, proj, inst);
  await writeIfChanged(path.join(projRoot, '.gitignore'), 'obj/\n');
  // AGENTS.md/CLAUDE.md：让 CLI 会话 / 其它 AI 助手不依赖扩展即可构建（见 src/cli/agentDocs.ts）
  await writeAgentDocs(projRoot, proj, inst);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
