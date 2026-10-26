import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  IS_WINDOWS,
  LINUX_PROBE_BASES,
  LINUX_PROBE_NAMES,
  MRS2_HOME_ENV,
  MRS_LINUX_DIR,
  PROBE_PATTERNS,
  SUB_MANIFEST_REL,
} from '../constants';
import { MrsInstallation } from './mrsInstallation';
import { pathExists } from '../util/fsx';

/**
 * Discovers the MounRiver Studio 2/3 installation:
 * setting → env var → curated patterns → shallow sweep → manual browse.
 * Windows: per-drive patterns + drive sweep. Linux/macOS: home/opt/usr/share
 * bases + the `MRS-linux-x64` payload dir both ways (选中解压目录或安装根均可)。
 * Results are cached in globalState keyed by root path.
 */
export class MrsLocator {
  /** In-memory cache — MrsInstallation carries live toolchain/chipdb objects. */
  private readonly cache = new Map<string, MrsInstallation>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async detect(candidatesFromSettings = true): Promise<string[]> {
    const found: string[] = [];
    // 归一化：候选目录本身不是安装根时，检查它下面的 MRS-linux-x64（用户常
    // 选到 tar 解压目录而不是里面的安装根）。Windows 上该目录不存在，行为不变。
    const push = (p: string | undefined) => {
      const root = resolveRootCandidate(p);
      if (root && !found.some((f) => f.toLowerCase() === root.toLowerCase())) {
        found.push(root);
      }
    };

    if (candidatesFromSettings) {
      push(expandHome(vscode.workspace.getConfiguration('mrsToolbox').get<string>('mounriverStudioPath')));
    }
    push(expandHome(process.env[MRS2_HOME_ENV]));

    if (IS_WINDOWS) {
      for (const drive of listDrives()) {
        for (const pattern of PROBE_PATTERNS) {
          push(pattern.replace('%', drive));
        }
      }

      // Shallow sweep: <drive>/xxx and <drive>/xxx/yyy matching *ounriver*。
      // l1 另认 mrs/mrs3 这类安装父目录（如 C:\mrs3\MounRiver_Studio3）；
      // 更深一层（C:\tool\mrs3\…）由 PROBE_PATTERNS 的显式模式兜底。
      for (const drive of listDrives()) {
        try {
          for (const l1 of fs.readdirSync(drive, { withFileTypes: true })) {
            if (!l1.isDirectory() || !/ounriver|(^|_)mrs\d*$/i.test(l1.name)) {
              continue;
            }
            const d1 = path.join(drive, l1.name);
            push(d1);
            for (const l2 of fs.readdirSync(d1, { withFileTypes: true })) {
              if (l2.isDirectory() && /ounriver/i.test(l2.name)) {
                push(path.join(d1, l2.name));
              }
            }
          }
        } catch {
          /* drive not readable */
        }
      }
    } else {
      const bases = linuxSearchBases();
      for (const base of bases) {
        for (const name of LINUX_PROBE_NAMES) {
          push(path.join(base, ...name.split('/')));
        }
      }

      // Shallow sweep: <base>/xxx matching *ounriver*|*mrs*，两层深度。
      for (const base of bases) {
        try {
          for (const l1 of fs.readdirSync(base, { withFileTypes: true })) {
            if (!l1.isDirectory() || !/ounriver|(^|_)mrs/i.test(l1.name)) {
              continue;
            }
            const d1 = path.join(base, l1.name);
            push(d1);
            for (const l2 of fs.readdirSync(d1, { withFileTypes: true })) {
              if (l2.isDirectory() && /ounriver|mrs/i.test(l2.name)) {
                push(path.join(d1, l2.name));
              }
            }
          }
        } catch {
          /* base not readable */
        }
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
      'MRS Toolbox: 未找到 MounRiver Studio 2/3 安装。请选择安装目录。',
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

/** Linux/macOS 探测基目录：LINUX_PROBE_BASES 展开 `~` 并去重（目录存在的才保留）。 */
function linuxSearchBases(): string[] {
  const out: string[] = [];
  for (const base of LINUX_PROBE_BASES) {
    const dir = expandHome(base) ?? base;
    if (!out.includes(dir) && fs.existsSync(dir)) {
      out.push(dir);
    }
  }
  return out;
}

/** `~/x` → `<home>/x`（也接受裸 `~`）；其余原样返回。 */
function expandHome(p: string | undefined): string | undefined {
  if (!p || !p.startsWith('~')) {
    return p;
  }
  const home = os.homedir();
  return p === '~' ? home : path.join(home, p.slice(2));
}

/** Synchronous cheap check: the manifest anchor exists. */
function isInstallRoot(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, SUB_MANIFEST_REL));
  } catch {
    return false;
  }
}

/** 候选目录 → 安装根：目录本身是根则原样返回，否则看它是否包含解压出的安装层。 */
function resolveRootCandidate(p: string | undefined): string | undefined {
  if (!p) {
    return undefined;
  }
  if (isInstallRoot(p)) {
    return p;
  }
  const nested = path.join(p, MRS_LINUX_DIR);
  return isInstallRoot(nested) ? nested : undefined;
}

/** Test helper: validate a root without a VSCode context. */
export async function loadInstallationStandalone(
  root: string,
): Promise<MrsInstallation | { error: string }> {
  const resolved = resolveRootCandidate(root) ?? root;
  const exists = await pathExists(path.join(resolved, SUB_MANIFEST_REL));
  if (!exists) {
    return { error: `no sub_manifest.json under ${resolved}` };
  }
  return MrsInstallation.load(resolved);
}
