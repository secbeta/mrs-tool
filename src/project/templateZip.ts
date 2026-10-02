import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { parseTemplateManifest } from '../chipdb/chipDatabase';
import type { TemplateManifest } from '../chipdb/types';

/** Files from the SDK template zip that we keep for MRS2 interop. */
const KEEP_DOT_FILES = new Set(['.cproject', '.project', '.launch', '.template']);

export interface ExtractResult {
  manifest: TemplateManifest | undefined;
  files: string[];
}

/**
 * Extract a template zip into `destDir`. Skips build artifacts and dot files
 * we do not use (the encrypted `.wvproj` never exists in templates, but other
 * stray dot files might).
 */
export function extractTemplateZip(zipPath: string, destDir: string): ExtractResult {
  const zip = new AdmZip(zipPath);
  fs.mkdirSync(destDir, { recursive: true });

  const files: string[] = [];
  let manifest: TemplateManifest | undefined;

  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
    const base = path.posix.basename(name);

    // Skip dot files except the MRS interop set.
    if (base.startsWith('.') && !KEEP_DOT_FILES.has(base)) {
      continue;
    }
    // Skip stale build output shipped inside some templates.
    if (/(^|\/)obj(\/|$)/i.test(name)) {
      continue;
    }

    const target = path.join(destDir, ...name.split('/'));
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    files.push(name);

    if (base === '.template') {
      manifest = parseTemplateManifest(entry.getData().toString('utf-8'));
    }
  }

  return { manifest, files };
}

/**
 * Top-level source dirs actually present after extraction (e.g.
 * `User`, `Peripheral`, `Startup`, `Core`, `Debug`, `Ld`).
 */
export function topSourceDirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase() !== 'obj')
    .map((e) => e.name);
}
