import * as vscode from 'vscode';
import * as path from 'path';
import type { ExampleEntry, ExampleLibrary } from '../examples/exampleLibrary';
import {
  libraryDirs,
  libraryExists,
  libraryLabel,
  scanAllLibraries,
} from '../examples/libraryManager';
import type { ToolboxContext } from '../toolbox';

type ExampleNode =
  | { kind: 'library'; dir: string }
  | { kind: 'chip'; lib: ExampleLibrary; chipFolder: string }
  | { kind: 'category'; lib: ExampleLibrary; chipFolder: string; label: string }
  | { kind: 'example'; entry: ExampleEntry };

const CTX_EXAMPLES_EMPTY = 'mrsToolbox.examplesEmpty';

const STYLE_BADGE: Record<ExampleEntry['style'], string> = {
  mrs2: 'MRS2',
  mrs1: 'MRS1',
  keil: 'Keil',
  plain: 'src',
};

/**
 * Examples view: library → chip folder → category → example (four levels).
 * Multiple example libraries coexist (like ESP-IDF's IDF + ADF installs);
 * add/remove them from the view toolbar or the configuration page.
 * Example nodes carry a "create project" inline action (package.json menus).
 */
export class ExamplesTree implements vscode.TreeDataProvider<ExampleNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private libs: ExampleLibrary[] | undefined;

  constructor(private readonly tbx: ToolboxContext) {
    tbx.onDidChange(() => void this.rescan());
  }

  async rescan(): Promise<void> {
    this.libs = scanAllLibraries();
    const total = this.libs.reduce((n, l) => n + l.examples.length, 0);
    await vscode.commands.executeCommand('setContext', CTX_EXAMPLES_EMPTY, total === 0);
    this._onDidChange.fire();
  }

  getTreeItem(node: ExampleNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.kind === 'example' ? node.entry.name : this.nodeLabel(node),
      node.kind === 'example'
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    switch (node.kind) {
      case 'library': {
        item.iconPath = new vscode.ThemeIcon('library');
        item.contextValue = 'library';
        item.description = this.libraryDescription(node.dir);
        item.tooltip = node.dir;
        break;
      }
      case 'chip': {
        item.iconPath = new vscode.ThemeIcon('circuit-board');
        item.description = chipDescription(node.lib, node.chipFolder);
        break;
      }
      case 'category': {
        item.iconPath = new vscode.ThemeIcon('folder');
        break;
      }
      case 'example': {
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.description = `${STYLE_BADGE[node.entry.style]} · ${node.entry.type}`;
        item.tooltip = node.entry.path;
        item.contextValue = 'example';
        item.command = {
          command: 'mrsToolbox.createProjectFromExample',
          title: '从例程创建工程',
          arguments: [node.entry],
        };
        break;
      }
    }
    return item;
  }

  async getChildren(node?: ExampleNode): Promise<ExampleNode[]> {
    if (!this.libs) {
      await this.rescan();
    }
    const libs = this.libs ?? [];

    if (!node) {
      // Empty list → let viewsWelcome take over.
      return libraryDirs().length === 0
        ? []
        : libs.map((l) => ({ kind: 'library' as const, dir: l.root }));
    }

    if (node.kind === 'library') {
      const lib = libs.find((l) => l.root === node.dir);
      if (!lib) {
        return [];
      }
      if (lib.examples.length === 0) {
        return [];
      }
      const chips = [...new Set(lib.examples.map((e) => e.chipFolder))];
      return chips.map((chipFolder) => ({ kind: 'chip' as const, lib, chipFolder }));
    }

    if (node.kind === 'chip') {
      const of = node.lib.examples.filter((e) => e.chipFolder === node.chipFolder);
      const categories = [...new Set(of.map((e) => e.category).filter(Boolean))];
      const nodes: ExampleNode[] = categories.map((category) => ({
        kind: 'category',
        lib: node.lib,
        chipFolder: node.chipFolder,
        label: category,
      }));
      // Examples sitting directly under EXAM (no category) show at chip level.
      for (const e of of.filter((e) => !e.category)) {
        nodes.push({ kind: 'example', entry: e });
      }
      return nodes;
    }

    if (node.kind === 'category') {
      return node.lib.examples
        .filter((e) => e.chipFolder === node.chipFolder && e.category === node.label)
        .map((e) => ({ kind: 'example' as const, entry: e }));
    }

    return [];
  }

  private nodeLabel(node: ExampleNode): string {
    if (node.kind === 'library') {
      return libraryLabel(node.dir);
    }
    if (node.kind === 'chip') {
      return node.chipFolder;
    }
    if (node.kind === 'category') {
      return node.label;
    }
    return '';
  }

  private libraryDescription(dir: string): string {
    const lib = (this.libs ?? []).find((l) => l.root === dir);
    if (!libraryExists(dir)) {
      return '目录不存在';
    }
    const chips = new Set(lib?.examples.map((e) => e.chipFolder) ?? []).size;
    return `${lib?.examples.length ?? 0} 例程 · ${chips} 芯片`;
  }
}

function chipDescription(lib: ExampleLibrary, chipFolder: string): string {
  const count = lib.examples.filter((e) => e.chipFolder === chipFolder).length;
  const series = lib.examples.find((e) => e.chipFolder === chipFolder)?.series;
  return `${series ?? '?'} · ${count} 例程`;
}

/** QuickPick over all examples in all libraries (command-palette flow). */
export async function pickExample(
  libs: ExampleLibrary[],
): Promise<ExampleEntry | undefined> {
  const multiLib = libs.length > 1;
  const items = libs.flatMap((lib) =>
    lib.examples.map((e) => ({
      label: e.name,
      description: `${multiLib ? `${libraryLabel(lib.root)} · ` : ''}${e.chipFolder}${e.category ? ` · ${e.category}` : ''} · ${STYLE_BADGE[e.style]}`,
      detail: e.path,
      entry: e,
    })),
  );
  if (items.length === 0) {
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `选择例程（共 ${items.length} 个）`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.entry;
}

/** Default project folder name for an example: sanitized, ASCII-safe. */
export function exampleProjectName(entry: ExampleEntry, mcuId: string): string {
  const raw = `${mcuId}_${entry.name}`;
  const safe = raw.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || mcuId;
}

export function parentOf(p: string): string {
  return path.dirname(p);
}
