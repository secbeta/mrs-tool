import * as fs from 'fs';
import * as path from 'path';
import type { MrsProject } from '../project/projectModel';
import { toPosix, writeIfChanged } from '../util/fsx';

/**
 * Keeps the Eclipse CDT `.cproject` (what MounRiver Studio 2 builds from) in
 * sync with `.mrs-project.json`. Without this, projects created from examples
 * keep the SDK template's `.cproject`, whose include paths / linker script /
 * libraries point at sibling directories of the template ("../StdPeriphDriver")
 * that don't exist in the created project — MRS2 then fails with
 * `fatal error: HAL.h: No such file or directory` even though the extension's
 * own Makefile (which collects includes recursively) builds fine.
 *
 * Values are written in the same `${workspace_loc:/${ProjName}/…}` form WCH
 * ships in EVT example projects, so they resolve wherever the project lives.
 */

export interface CprojectSyncPlan {
  /** Project-relative include dirs (posix), mirrors the Makefile INCLUDES scan. */
  includePaths: string[];
  defines: string[];
  /** Project-relative library search dirs (posix). */
  libPaths: string[];
  /** `-l` names derived from the bundled `lib*.a` archives. */
  libNames: string[];
  linkerScript: string;
  excludedPaths: string[];
}

const SKIP_DIRS = new Set(['obj', '.git', '.vscode', '.settings', '.mrs']);

/** Recursive header-dir scan over srcDirs ∪ libDirs — same set the Makefile uses. */
function collectHeaderDirs(root: string, dir: string, out: Set<string>): void {
  const abs = path.join(root, dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && /\.h$/i.test(e.name))) {
    out.add(toPosix(dir));
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      collectHeaderDirs(root, path.posix.join(toPosix(dir), e.name), out);
    }
  }
}

/** `-l` names for every `.a` under libDirs (`libCH58xBLE.a` → `CH58xBLE`). */
function collectLibNames(root: string, libDirs: string[]): string[] {
  const names: string[] = [];
  const walk = (abs: string, depth: number): void => {
    if (depth > 3) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(abs, e.name);
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        walk(p, depth + 1);
      } else if (e.isFile() && /\.a$/i.test(e.name)) {
        const stem = e.name.replace(/\.a$/i, '');
        names.push(/^lib/i.test(stem) ? stem.replace(/^lib/i, '') : stem);
      }
    }
  };
  for (const d of libDirs) {
    walk(path.join(root, d), 0);
  }
  return [...new Set(names)].sort();
}

export function planFromProject(projRoot: string, proj: MrsProject): CprojectSyncPlan {
  const headerDirs = new Set<string>();
  for (const dir of [...proj.build.srcDirs, ...proj.build.libDirs]) {
    collectHeaderDirs(projRoot, dir, headerDirs);
  }
  for (const extra of proj.build.extraIncludes) {
    // Only project-relative paths translate to ${ProjName} workspace paths;
    // absolute/system includes stay Makefile/IntelliSense-only.
    if (!/^[a-zA-Z]:[\\/]|^[\\/]/.test(extra)) {
      headerDirs.add(toPosix(extra));
    }
  }
  return {
    includePaths: [...headerDirs].sort(),
    defines: proj.build.defines,
    libPaths: proj.build.libDirs.map(toPosix),
    libNames: collectLibNames(projRoot, proj.build.libDirs),
    linkerScript: toPosix(proj.build.linkerScript),
    excludedPaths: proj.build.excludedPaths.map(toPosix),
  };
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const workspacePath = (p: string): string => `\${workspace_loc:/\${ProjName}/${p}}`;

/**
 * Replace the `<listOptionValue>` children of every `<option>` whose opening
 * tag satisfies `attr` (tested against the tag only, e.g.
 * /valueType="includePath"/). Handles both the open and self-closing forms;
 * options without a match are left untouched.
 */
function setListValues(xml: string, attr: RegExp, values: string[], quoted: boolean): string {
  // Lazy attrs so a self-closing `/>` wins over running on into the *next*
  // option's closing tag (greedy `[^>]*` can eat the `/` of `/>`).
  const elementRe = /([ \t]*)<option\b[^>]*?(?:\/>|>[\s\S]*?<\/option>)/g;
  return xml.replace(elementRe, (element) => {
    const openTagEnd = element.indexOf('>');
    // Slice from '<' — the match text includes the leading indentation, which
    // must not end up inside (and get doubled with) the emitted open tag.
    const openTag = element.slice(element.indexOf('<'), openTagEnd);
    if (!attr.test(openTag)) {
      return element;
    }
    const indent = element.match(/^[ \t]*/)?.[0] ?? '';
    const tag = openTag
      .replace(/\/$/, '')
      .replace(/ IS_VALUE_EMPTY="true"/, ' IS_VALUE_EMPTY="false"');
    if (values.length === 0) {
      return `${indent}${tag} IS_VALUE_EMPTY="true"/>`;
    }
    const children = values
      .map((v) => `${indent}\t<listOptionValue builtIn="false" value="${escapeAttr(quoted ? `"${v}"` : v)}"/>`)
      .join('\n');
    return `${indent}${tag}>\n${children}\n${indent}</option>`;
  });
}

/** Single project-root source entry; per-file exclusions join into `excluding=`. */
function setSourceEntries(xml: string, excludedPaths: string[]): string {
  const excluding = excludedPaths.length
    ? ` excluding="${escapeAttr(excludedPaths.join('|'))}"`
    : '';
  const entry = `<entry${excluding} flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name=""/>`;
  return xml.replace(
    /<sourceEntries>[\s\S]*?<\/sourceEntries>/g,
    `<sourceEntries>\n\t\t\t\t\t${entry}\n\t\t\t\t</sourceEntries>`,
  );
}

/** Pure rewriter — unit-testable without an installation or a project on disk. */
export function patchCproject(xml: string, plan: CprojectSyncPlan): string {
  let out = xml;
  out = setListValues(out, /valueType="includePath"/, plan.includePaths.map(workspacePath), true);
  out = setListValues(out, /valueType="definedSymbols"/, plan.defines, false);
  out = setListValues(out, /valueType="libPaths"/, plan.libPaths.map(workspacePath), true);
  out = setListValues(out, /valueType="libs"/, plan.libNames, false);
  // superClass (not valueType) pins the linker-script option: valueType is a
  // plain "stringList" shared with unrelated flags that must survive.
  out = setListValues(out, /superClass="[^"]*linker\.scriptfile"/, [workspacePath(plan.linkerScript)], true);
  out = setSourceEntries(out, plan.excludedPaths);
  return out;
}

/**
 * Patch the project's `.cproject` (if present) to match `.mrs-project.json`.
 * No-op when the project has none (plain source imports). Called from
 * finalizeProject, so "Generate Build Files" repairs existing projects too.
 */
export async function syncCproject(projRoot: string, proj: MrsProject): Promise<boolean> {
  const file = path.join(projRoot, '.cproject');
  if (!fs.existsSync(file)) {
    return false;
  }
  const plan = planFromProject(projRoot, proj);
  const patched = patchCproject(fs.readFileSync(file, 'utf-8'), plan);
  await writeIfChanged(file, patched);
  return true;
}
