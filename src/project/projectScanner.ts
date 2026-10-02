import * as fs from 'fs';
import * as path from 'path';

export interface ScanSuggestion {
  /** Directories (relative) that contain C/C++/asm sources. */
  srcDirs: string[];
  /** Directories (relative) that contain prebuilt `.a` libraries. */
  libDirs: string[];
  /** First linker script found (relative), preferring Ld/LD dirs. */
  linkerScript?: string;
  /** Startup file (relative), for display. */
  startupFile?: string;
}

const SRC_EXT = new Set(['.c', '.cpp', '.cc', '.cxx', '.s', '.S']);
const SKIP_DIRS = new Set(['obj', 'out', 'build', 'bin', '.vscode', '.git', 'node_modules', '.settings']);

/**
 * Walk a source folder (max 3 levels) and suggest build inputs for the
 * import wizard. Deliberately shallow: EVT layouts are 2–3 deep.
 */
export function scanProject(root: string): ScanSuggestion {
  const srcDirs = new Set<string>();
  const libDirs = new Set<string>();
  const linkerCandidates: { rel: string; score: number }[] = [];
  let startupFile: string | undefined;

  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 3) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) {
          continue;
        }
        walk(path.join(dir, e.name), relPath, depth + 1);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (SRC_EXT.has(ext)) {
          srcDirs.add(rel || '.');
          if ((ext === '.s' || ext === '.S') && !startupFile) {
            startupFile = relPath;
          }
        } else if (ext === '.a') {
          libDirs.add(rel || '.');
        } else if (ext === '.ld' || ext === '.sct' || ext === '.lds') {
          const score = /ld/i.test(rel) ? 0 : 1;
          linkerCandidates.push({ rel: relPath, score });
        }
      }
    }
  };

  walk(root, '', 0);

  linkerCandidates.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel));
  return {
    srcDirs: [...srcDirs].sort(),
    libDirs: [...libDirs].sort(),
    linkerScript: linkerCandidates[0]?.rel,
    startupFile,
  };
}

/**
 * Extra defines suggested for CH58x-family projects (BLE EVT convention):
 * `CHIP_ID=<mcuId without the final letter>`, e.g. CH582F → CH582.
 */
export function suggestChipDefine(mcuId: string, series: string): string | undefined {
  if (/^CH5[6-9]/.test(series) || /^CH58/.test(mcuId)) {
    const chip = mcuId.replace(/F|M|K|R|T|U|P$/i, '');
    return `CHIP_ID=${chip}`;
  }
  return undefined;
}
