import * as fs from 'fs';
import * as path from 'path';
import { EXAMPLE_SERIES_MAP } from '../constants';

export type ExampleStyle = 'mrs2' | 'mrs1' | 'keil' | 'plain';

export interface ExampleEntry {
  /** Library chip folder, e.g. `CH32V00x`. */
  chipFolder: string;
  /** SDK series name, e.g. `CH32V003` (resolved via EXAMPLE_SERIES_MAP). */
  series: string;
  type: 'RISC-V' | 'ARM';
  /** Peripheral/category group, e.g. `GPIO`, `BLE`. */
  category: string;
  name: string;
  path: string;
  style: ExampleStyle;
}

export interface ExampleLibrary {
  root: string;
  examples: ExampleEntry[];
}

/** WCH EVT convention: `SRC` under EXAM is a shared source pool, never an example. */
const SKIP_NAMES = new Set(['obj', 'src', 'pub', 'build', 'output']);
/**
 * Folder names that hold sources *inside* a project — a directory with flat .c
 * files is only an example when it is not one of these (e.g. `User/`, `APP/`).
 */
const SOURCE_DIR_NAMES = new Set([
  'user', 'src', 'app', 'core', 'startup', 'peripheral', 'rvmsis',
  'stdperiphdriver', 'hal', 'profile', 'debug', 'ld', 'obj', 'drivers',
]);
/** How many container levels may sit between EXAM and an example (USB → USBD → …). */
const MAX_CATEGORY_DEPTH = 4;

/**
 * Project-file markers. Eclipse dotfiles (`.cproject`) match by exact name;
 * Keil/WCH ones are *named* files (`CH32F10x.uvprojx`, `GPIO_Toggle.wvproj`)
 * and must match by extension.
 */
function hasProjectMarker(names: Set<string>): boolean {
  if (names.has('.cproject')) {
    return true;
  }
  for (const n of names) {
    if (n.endsWith('.uvprojx') || n.endsWith('.uvproj') || n.endsWith('.wvproj')) {
      return true;
    }
  }
  return false;
}

function hasDirectCFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => /\.c$/i.test(f));
  } catch {
    return false;
  }
}

/** Prebuilt static libs mark support folders (Udisk_Lib/TKYLIB), not examples. */
function hasPrebuiltLibs(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => /\.(a|lib)$/i.test(f));
  } catch {
    return false;
  }
}

function classify(dir: string): ExampleStyle {
  const names = fs.readdirSync(dir).map((f) => f.toLowerCase());
  const hasExt = (ext: string) => names.some((n) => n.endsWith(ext));
  if (hasExt('.uvprojx') || hasExt('.uvproj')) {
    return 'keil';
  }
  if (hasExt('.wvproj')) {
    return 'mrs2';
  }
  if (names.includes('.cproject')) {
    return 'mrs1';
  }
  return 'plain';
}

/** Locate the EXAM dir: `<chip>/EVT/EXAM`, `<chip>/EXAM`, or `<chip>` itself. */
function findExamDir(chipDir: string): string | undefined {
  for (const candidate of [path.join(chipDir, 'EVT', 'EXAM'), path.join(chipDir, 'EXAM'), chipDir]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Scan the examples library. Layout understood:
 * `<root>/<ChipFolder>/[EVT/]EXAM/<Category>[/<Subcategory>]/<Example>`.
 *
 * A directory is an **example** when it carries a project file (`.cproject`,
 * `.uvprojx`, `.uvproj`, `.wvproj`) or flat `.c` sources at its top (plain
 * style). Everything else is a **category container** and is descended into,
 * so nested groups like `USB/USBD/<example>` keep working. A marker-less
 * container whose subdirs hold `.c` files but yield no examples is itself a
 * plain-style example (retro rule).
 */
interface ChipCtx {
  chipFolder: string;
  series: string;
  type: 'RISC-V' | 'ARM';
}

export function scanExampleLibrary(root: string): ExampleLibrary {
  const examples: ExampleEntry[] = [];
  if (!fs.existsSync(root)) {
    return { root, examples };
  }

  for (const chip of fs.readdirSync(root, { withFileTypes: true })) {
    if (!chip.isDirectory() || chip.name.startsWith('.')) {
      continue;
    }
    const mapping = EXAMPLE_SERIES_MAP[chip.name.toUpperCase()];
    const exam = findExamDir(path.join(root, chip.name));
    if (!exam) {
      continue;
    }
    // The EXAM tree itself identifies the chip more reliably than the map when
    // the folder name is generic (e.g. CH32V00x covers V002..V007).
    const ctx: ChipCtx = {
      chipFolder: chip.name,
      series: mapping?.series ?? chip.name,
      type: mapping?.type ?? 'RISC-V',
    };
    walk(ctx, examples, exam, [], 0);
  }

  return { root, examples };
}

/**
 * Walk one EXAM subtree. `cat` holds the category names strictly ABOVE `dir`
 * (the EXAM root itself is not a category); `depth` counts levels below EXAM.
 * Returns how many examples were found under `dir` (0 for none).
 */
function walk(ctx: ChipCtx, out: ExampleEntry[], dir: string, cat: string[], depth: number): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  const base = path.basename(dir);

  // Project file present → decisively an example project.
  if (hasProjectMarker(names)) {
    out.push(mk(ctx, cat.join('/'), base, dir));
    return 1;
  }
  // Flat sources → plain example, unless the folder is a known source
  // container inside a project (User/, APP/, …) or ships prebuilt libraries
  // (Udisk_Lib/TKYLIB-style support folders, not examples).
  if (
    entries.some((e) => e.isFile() && /\.c$/i.test(e.name)) &&
    !hasPrebuiltLibs(dir) &&
    (cat.length === 0 || !SOURCE_DIR_NAMES.has(base.toLowerCase()))
  ) {
    out.push(mk(ctx, cat.join('/'), base, dir));
    return 1;
  }

  // Category container: descend (bounded). Children inherit our own name as
  // an ancestor; the EXAM root (depth 0) stays out of the category path.
  let found = 0;
  if (depth < MAX_CATEGORY_DEPTH) {
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_NAMES.has(e.name.toLowerCase())) {
        continue;
      }
      found += walk(ctx, out, path.join(dir, e.name), depth === 0 ? cat : [...cat, base], depth + 1);
    }
  }
  // Retro rule: nothing inside, but subdirs carry app sources (prebuilt-lib
  // support folders don't count) → the dir itself is a plain-style example.
  // Never fires for the EXAM root or source dirs.
  if (
    found === 0 &&
    cat.length > 0 &&
    !SOURCE_DIR_NAMES.has(base.toLowerCase()) &&
    entries.some(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith('.') &&
        !SKIP_NAMES.has(e.name.toLowerCase()) &&
        hasDirectCFiles(path.join(dir, e.name)) &&
        !hasPrebuiltLibs(path.join(dir, e.name)),
    )
  ) {
    out.push(mk(ctx, cat.join('/'), base, dir));
    return 1;
  }
  return found;
}

function mk(ctx: ChipCtx, category: string, name: string, p: string): ExampleEntry {
  return {
    chipFolder: ctx.chipFolder,
    series: ctx.series,
    type: ctx.type,
    category,
    name,
    path: p,
    style: classify(p),
  };
}
