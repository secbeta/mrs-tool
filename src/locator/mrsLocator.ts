import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MRS2_HOME_ENV, PROBE_PATTERNS, SUB_MANIFEST_REL } from '../constants';
import { MrsInstallation } from './mrsInstallation';
import { pathExists } from '../util/fsx';

/**
 * Discovers the MounRiver Studio 2 installation:
 * setting → env var → curated per-drive patterns → shallow drive sweep →
 * (opportunistic) Windows registry → manual browse. Results are cached in
 * globalState keyed by root path.
 */
export class MrsLocator {
  /** In-memory cache — MrsInstallation carries live toolchain/chipdb objects. */
  private readonly cache = new Map<string, MrsInstallation>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async detect(candidatesFromSettings = true): Promise<string[]> {
    const found: string[] = [];
    const push = (p: string | undefined) => {
      if (p && !found.some((f) => f.toLowerCase() === p!.toLowerCase())) {
        found.push(p);
      }
    };

    if (candidatesFromSettings) {
      push(vscode.workspace.getConfiguration('mrsToolbox').get<string>('mounriverStudioPath'));
    }
    push(process.env[MRS2_HOME_ENV]);

    for (const drive of listDrives()) {
      for (const pattern of PROBE_PATTERNS) {
        push(pattern.replace('%', drive));
      }
    }

    // Shallow sweep: <drive>/xxx and <drive>/xxx/yyy matching *ounriver*.
    for (const drive of listDrives()) {
      try {
        for (const l1 of fs.readdirSync(drive, { withFileTypes: true })) {
          if (!l1.isDirectory() || !/ounriver/i.test(l1.name)) {
            continue;
          }
          const d1 = path.join(drive, l1.name);
          push(isInstallRoot(d1) ? d1 : undefined);
          for (const l2 of fs.readdirSync(d1, { withFileTypes: true })) {
            if (l2.isDirectory() && /ounriver/i.test(l2.name)) {
              const d2 = path.join(d1, l2.name);
              push(isInstallRoot(d2) ? d2 : undefined);
            }
          }
        }
      } catch {
        /* drive not readable */
      }
    }

    return found.filter((p) => isInstallRoot(p));
  }

  /** Load the installation from an explicit root (validated). */
  async loadFrom(root: string): Promise<MrsInstallation | { error: string }> {
    const cached = this.cacheGet(root);
    if (cached) {
      return cached;
    }
    const loaded = await MrsInstallation.load(root, this.overrides());
    if (loaded instanceof MrsInstallation) {
      this.cachePut(loaded);
    }
    return loaded;
  }

  /**
   * Resolve the active installation; shows an error + opens the browse flow
   * when nothing valid can be found. Returns undefined then.
   */
  async require(): Promise<MrsInstallation | undefined> {
    const roots = await this.detect();
    for (const root of roots) {
      const inst = await this.loadFrom(root);
      if (inst instanceof MrsInstallation) {
        return inst;
      }
    }
    const pick = await vscode.window.showErrorMessage(
      'MRS Toolbox: 未找到 MounRiver Studio 2 安装。请选择安装目录。',
      '浏览…',
    );
    if (pick === '浏览…') {
      await vscode.commands.executeCommand('mrsToolbox.setMounriverPath');
      // Retry once after the user picked a folder.
      const roots2 = await this.detect();
      for (const root of roots2) {
        const inst = await this.loadFrom(root);
        if (inst instanceof MrsInstallation) {
          return inst;
        }
      }
    }
    return undefined;
  }

  private overrides() {
    const cfg = vscode.workspace.getConfiguration('mrsToolbox');
    return {
      sdkOverride: cfg.get<string>('sdkDirectory') || undefined,
      toolchainOverrides: {
        GCC8: cfg.get<string>('toolchainOverride.gcc8') || '',
        GCC12: cfg.get<string>('toolchainOverride.gcc12') || '',
        ARM: cfg.get<string>('toolchainOverride.arm') || '',
      },
    };
  }

  private cacheKey(root: string): string {
    return root.toLowerCase();
  }

  private cacheGet(root: string): MrsInstallation | undefined {
    return this.cache.get(this.cacheKey(root));
  }

  private cachePut(inst: MrsInstallation): void {
    this.cache.set(this.cacheKey(inst.root), inst);
  }
}

function listDrives(): string[] {
  const drives: string[] = [];
  for (let i = 67; i <= 90; i++) {
    const drive = `${String.fromCharCode(i)}:`;
    if (fs.existsSync(path.join(drive, '\\'))) {
      drives.push(drive);
    }
  }
  return drives;
}

/** Synchronous cheap check: the manifest anchor exists. */
function isInstallRoot(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, SUB_MANIFEST_REL));
  } catch {
    return false;
  }
}

/** Test helper: validate a root without a VSCode context. */
export async function loadInstallationStandalone(
  root: string,
): Promise<MrsInstallation | { error: string }> {
  const exists = await pathExists(path.join(root, SUB_MANIFEST_REL));
  if (!exists) {
    return { error: `no sub_manifest.json under ${root}` };
  }
  return MrsInstallation.load(root);
}
