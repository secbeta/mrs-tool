import * as fs from 'fs';
import * as path from 'path';
import { pathExistsSync } from '../util/fsx';

export interface LinkedFolder {
  /** Virtual folder name inside the project (e.g. `StdPeriphDriver`). */
  name: string;
  /** Absolute path on disk (resolved from locationURI/location). */
  absPath: string;
}

export interface CprojectInfo {
  defines: string[];
  includePaths: string[];
  linkedFolders: LinkedFolder[];
  /** Links whose PARENT-n target no longer exists (bare copies of examples). */
  unresolvedLinks: { name: string; uri: string }[];
  /** Paths kept out of the build (Eclipse sourceEntries `excluding=…`). */
  excludedPaths: string[];
}

/**
 * Minimal regex parsers for the Eclipse CDT files shipped in EVT examples.
 * Avoids an XML dependency — the structures are machine-generated and stable.
 */
export function parseProjectFile(projectDir: string): CprojectInfo {
  const info: CprojectInfo = {
    defines: [],
    includePaths: [],
    linkedFolders: [],
    unresolvedLinks: [],
    excludedPaths: [],
  };
  const dotProject = path.join(projectDir, '.project');
  const dotCproject = path.join(projectDir, '.cproject');

  if (pathExistsSync(dotProject)) {
    const text = readText(dotProject);
    // Each <link> block: <name>…</name> … <locationURI>PARENT-2-PROJECT_LOC/SRC/X</locationURI>
    // Some examples ship the same pseudo-URI in a plain <location> tag instead
    // (BLE_UART does). PARENT-n-PROJECT_LOC = n levels up from the project dir.
    const linkRe = /<link>([\s\S]*?)<\/link>/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(text))) {
      const block = m[1];
      const name = matchTag(block, 'name');
      if (!name) {
        continue;
      }
      const uri = matchTag(block, 'locationURI');
      const loc = matchTag(block, 'location');
      const raw = uri ?? loc;
      let abs: string | undefined;
      if (raw) {
        abs = resolveLocationUri(raw, projectDir);
        if (!abs && loc) {
          abs = path.isAbsolute(loc) ? loc : path.resolve(projectDir, loc);
        }
      }
      if (abs && pathExistsSync(abs)) {
        info.linkedFolders.push({ name, absPath: abs });
      } else if (abs || raw) {
        info.unresolvedLinks.push({ name, uri: raw ?? '' });
      }
    }
  }

  if (pathExistsSync(dotCproject)) {
    const text = readText(dotCproject);
    info.defines = listOptionValues(text, 'definedSymbols')
      .map((v) => v.replace(/^["']|["']$/g, ''))
      .filter((v) => v && !v.startsWith('${'));
    info.includePaths = listOptionValues(text, 'includePath')
      .map((v) => cleanIncludePath(v))
      .filter((v): v is string => !!v);
    info.excludedPaths = parseSourceExclusions(text);
  }

  return info;
}

/**
 * Eclipse `sourceEntries` exclude paths from the build via `excluding="a|b|c"`.
 * Paths are relative to their entry's `name` folder (`name=""` = project
 * root; `name="HAL"` makes `Profile` mean `HAL/Profile`).
 *
 * Gotcha: when a folder is ALSO registered as its own sourcePath entry, the
 * parent's `excluding` of it merely prevents double-counting — the folder is
 * still built (GPIO_Toggle's root excludes `Startup|Peripheral|…`, each of
 * which has its own entry). Only exclusions with no matching re-registration
 * are real.
 */
function parseSourceExclusions(text: string): string[] {
  const entryNames = new Set<string>();
  const withExclusions: { base: string; raw: string }[] = [];
  const entryRe = /<entry\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(text))) {
    const tag = m[0];
    if (!/kind="sourcePath"/.test(tag)) {
      continue;
    }
    const nameAttr = /name="([^"]*)"/.exec(tag);
    const name = (nameAttr?.[1] ?? '').trim();
    entryNames.add(name);
    const ex = /excluding="([^"]*)"/.exec(tag);
    if (ex) {
      withExclusions.push({ base: name.replace(/\/+$/, ''), raw: unescapeXml(ex[1]) });
    }
  }

  const out: string[] = [];
  for (const { base, raw } of withExclusions) {
    for (const p of raw.split('|')) {
      const rel = p.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
      if (!rel) {
        continue;
      }
      const abs = base ? `${base}/${rel}` : rel;
      if (!entryNames.has(abs)) {
        out.push(abs);
      }
    }
  }
  return out;
}

function readText(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

function matchTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1].trim() : undefined;
}

function resolveLocationUri(uri: string, projectDir: string): string | undefined {
  // e.g. PARENT-2-PROJECT_LOC/SRC/RVMSIS
  const m = /^PARENT-(\d+)-PROJECT_LOC\/?(.*)$/.exec(uri);
  if (m) {
    const up = Number(m[1]);
    let dir = projectDir;
    for (let i = 0; i < up; i++) {
      dir = path.dirname(dir);
    }
    return path.join(dir, ...m[2].split('/'));
  }
  return undefined;
}

function listOptionValues(text: string, valueType: string): string[] {
  const values: string[] = [];
  // valueType="definedSymbols" ... followed by listOptionValue entries.
  const blockRe = new RegExp(`valueType="${valueType}"[\\s\\S]*?(?=<option |<tool |$)`, 'g');
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(text))) {
    const valRe = /<listOptionValue[^>]*value="([^"]*)"/g;
    let v: RegExpExecArray | null;
    while ((v = valRe.exec(block[0]))) {
      values.push(unescapeXml(v[1]));
    }
  }
  return values;
}

function cleanIncludePath(raw: string): string | undefined {
  let v = raw.replace(/^["']|["']$/g, '');
  // ${workspace_loc:/ProjName/Dir} → Dir ; ${workspace_loc:/${ProjName}/Dir} → Dir
  const m = /\$\{workspace_loc:\/(?:\$\{ProjName\}|[^/}]*)\/?(.*)\}/.exec(v);
  if (m) {
    v = m[1];
  } else if (v.includes('${')) {
    return undefined;
  }
  return v || undefined;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
