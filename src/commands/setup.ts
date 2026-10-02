import * as vscode from 'vscode';
import type { ToolboxContext } from '../toolbox';
import { pickMounriverRoot } from '../project/wizard';
import { libraryDirs, libraryLabel } from '../examples/libraryManager';
import { getLogChannel } from '../util/log';

/** Setup: (re)detect or point at the MRS2 install and print a summary. */
export async function runSetup(tbx: ToolboxContext, forceBrowse = false): Promise<void> {
  const ch = getLogChannel();
  ch.show(true);

  if (forceBrowse) {
    const root = await pickMounriverRoot(tbx.installation?.root);
    if (!root) {
      return;
    }
    await vscode.workspace.getConfiguration('mrsToolbox').update(
      'mounriverStudioPath',
      root,
      vscode.ConfigurationTarget.Global,
    );
  }

  const inst = await tbx.ensureInstallation(true);
  if (!inst) {
    ch.appendLine('未找到可用的 MounRiver Studio 2 安装。');
    ch.appendLine('请运行 "MRS Toolbox: Set MounRiver Studio Path" 手动选择安装目录。');
    return;
  }
  ch.clear();
  ch.appendLine('== MRS Toolbox Setup ==');
  ch.appendLine(inst.summary);
  ch.appendLine('');
  const dirs = libraryDirs();
  ch.appendLine(`例程库 (${dirs.length} 个):`);
  for (const d of dirs) {
    ch.appendLine(`  - ${libraryLabel(d)}  ${d}`);
  }
  if (dirs.length === 0) {
    ch.appendLine('  (未配置 — 用 "Add Examples Library" 或配置页面添加)');
  }
  void vscode.window.showInformationMessage('MRS Toolbox 配置完成。');
}

/** Manual path selection → validate → persist → refresh. */
export async function runSetMounriverPath(tbx: ToolboxContext): Promise<void> {
  const root = await pickMounriverRoot(tbx.installation?.root);
  if (!root) {
    return;
  }
  await vscode.workspace.getConfiguration('mrsToolbox').update(
    'mounriverStudioPath',
    root,
    vscode.ConfigurationTarget.Global,
  );
  await runSetup(tbx);
}

export function registerSetupCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mrsToolbox.setup', () => runSetup(tbx)),
    vscode.commands.registerCommand('mrsToolbox.setMounriverPath', () => runSetMounriverPath(tbx)),
  ];
}
