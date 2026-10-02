import * as vscode from 'vscode';
import * as path from 'path';
import { MrsLocator } from './locator/mrsLocator';
import type { MrsInstallation } from './locator/mrsInstallation';
import { CTX_ACTIVE, CTX_INSTALLED, PROJECT_MARKER } from './constants';
import { findWorkspaceProjects, loadProject, type MrsProject } from './project/projectModel';
import { pathExists } from './util/fsx';

/**
 * Shared runtime state: installation, active project, context keys.
 * The active project is the folder holding the marker file — found at a
 * workspace-folder root or nested below it (see findWorkspaceProjects) —
 * or, when several exist, the one remembered via workspaceState. Commands
 * that need a project prompt for a choice when several exist and none is
 * remembered (see require/pickProjectRoot).
 */
export class ToolboxContext {
  readonly locator: MrsLocator;
  private _inst?: MrsInstallation;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _buildConfig: 'debug' | 'release' = 'debug';
  /** Discovered project roots (cleared by refresh — creation/selection). */
  private _rootsCache?: string[];

  constructor(readonly ext: vscode.ExtensionContext) {
    this.locator = new MrsLocator(ext);
    this._buildConfig = ext.workspaceState.get<'debug' | 'release'>('buildConfig') ?? 'debug';
  }

  get installation(): MrsInstallation | undefined {
    return this._inst;
  }

  get buildConfig(): 'debug' | 'release' {
    return this._buildConfig;
  }

  setBuildConfig(c: 'debug' | 'release'): void {
    this._buildConfig = c;
    void this.ext.workspaceState.update('buildConfig', c);
    this.refresh();
  }

  async ensureInstallation(force = false): Promise<MrsInstallation | undefined> {
    if (this._inst && !force) {
      return this._inst;
    }
    const inst = await this.locator.require();
    this._inst = inst;
    await vscode.commands.executeCommand('setContext', CTX_INSTALLED, !!inst);
    this.refresh();
    return inst;
  }

  /** Discovered project roots (cached between refreshes). */
  async workspaceProjects(): Promise<string[]> {
    this._rootsCache ??= await findWorkspaceProjects();
    return this._rootsCache;
  }

  /**
   * The remembered project root when it still exists among `roots`.
   * A single project needs no memory; a stale memory is dropped.
   */
  private rememberedRoot(roots: string[]): string | undefined {
    if (roots.length === 1) {
      return roots[0];
    }
    const remembered = this.ext.workspaceState.get<string>('activeProjectRoot');
    const hit = roots.find((r) => r.toLowerCase() === remembered?.toLowerCase());
    if (!hit && remembered) {
      void this.ext.workspaceState.update('activeProjectRoot', undefined);
    }
    return hit;
  }

  /**
   * QuickPick over project roots (folder name + MCU + workspace-relative
   * path). Used by selectProject and by require() when the choice is
   * ambiguous. Returns undefined when cancelled.
   */
  async pickProjectRoot(roots: string[]): Promise<string | undefined> {
    const items = await Promise.all(
      roots.map(async (root) => {
        const proj = await loadProject(root);
        return {
          label: path.basename(root),
          description: proj ? `${proj.mcu.mcuId} · ${proj.mcu.series} · ${proj.mcu.toolchainType}` : '',
          detail: this.workspaceRelative(root),
          root,
        };
      }),
    );
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `选择工程（共 ${roots.length} 个；之后可点状态栏芯片徽标切换）`,
    });
    return picked?.root;
  }

  /** Path relative to the containing workspace folder (display only). */
  private workspaceRelative(root: string): string {
    const folder = (vscode.workspace.workspaceFolders ?? []).find((f) =>
      root.toLowerCase().startsWith(f.uri.fsPath.toLowerCase()),
    );
    const base = folder?.uri.fsPath ?? path.dirname(root);
    const rel = path.relative(base, root);
    return rel ? rel.split(path.sep).join('/') : path.basename(root);
  }

  /** Active project root + parsed marker, or undefined. Never prompts. */
  async activeProject(): Promise<{ root: string; proj: MrsProject } | undefined> {
    const roots = await this.workspaceProjects();
    if (roots.length === 0) {
      await vscode.commands.executeCommand('setContext', CTX_ACTIVE, false);
      return undefined;
    }
    const root = this.rememberedRoot(roots) ?? roots[0];
    const proj = await loadProject(root);
    if (!proj) {
      await vscode.commands.executeCommand('setContext', CTX_ACTIVE, false);
      return undefined;
    }
    await vscode.commands.executeCommand('setContext', CTX_ACTIVE, true);
    return { root, proj };
  }

  setActiveProject(root: string): void {
    void this.ext.workspaceState.update('activeProjectRoot', root);
    this.refresh();
  }

  /**
   * Require both installation and project, or surface the right error.
   * With several projects and no remembered choice, ask once and remember —
   * this is the "which project does the build button mean?" prompt.
   */
  async require(): Promise<
    | { inst: MrsInstallation; root: string; proj: MrsProject }
    | undefined
  > {
    const inst = await this.ensureInstallation();
    if (!inst) {
      return undefined;
    }
    const roots = await this.workspaceProjects();
    if (roots.length === 0) {
      await vscode.commands.executeCommand('setContext', CTX_ACTIVE, false);
      vscode.window.showInformationMessage(
        '当前工作区没有 MRS Toolbox 工程（缺少 .mrs-project.json）。请先新建、从例程创建或导入工程。',
      );
      return undefined;
    }
    let root = this.rememberedRoot(roots);
    if (!root) {
      root = await this.pickProjectRoot(roots);
      if (!root) {
        return undefined;
      }
      this.setActiveProject(root);
    }
    const proj = await loadProject(root);
    if (!proj) {
      await vscode.commands.executeCommand('setContext', CTX_ACTIVE, false);
      return undefined;
    }
    await vscode.commands.executeCommand('setContext', CTX_ACTIVE, true);
    return { inst, root, proj };
  }

  refresh(): void {
    this._rootsCache = undefined;
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** Folder pick with a sane default and open-folder semantics. */
export async function pickFolder(
  defaultUri?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  return vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri,
    openLabel: '选择',
  }).then((r) => r?.[0]);
}

/** Marker existence check used by tree refresh. */
export async function hasProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
  return pathExists(path.join(folder.uri.fsPath, PROJECT_MARKER));
}
