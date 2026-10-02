import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolboxContext } from '../toolbox';
import { importWizard } from '../project/wizard';
import { createProject } from '../project/projectCreator';
import { PROJECT_MARKER } from '../constants';
import { libraryDirs } from '../examples/libraryManager';
import { log } from '../util/log';

/**
 * Import an existing source folder as a project (in place): series/MCU picked
 * with a name-based guess, then scan → suggests srcDirs/libDirs/linker/defines
 * and writes marker + Makefile + IntelliSense into that folder.
 */
export async function runImportProject(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  try {
    const pick = await importWizard(inst);
    if (!pick) {
      return;
    }
    if (fs.existsSync(path.join(pick.destDir, PROJECT_MARKER))) {
      void vscode.window.showInformationMessage(
        '该目录已是 MRS Toolbox 工程，已重新生成构建文件。',
      );
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'MRS Toolbox: 导入工程…' },
      () =>
        createProject(inst, {
          series: pick.series,
          mcuId: pick.mcuId,
          destDir: pick.destDir,
          createdFrom: 'import',
          searchRoots: libraryDirs(),
        }),
    );
    log(`imported project ${pick.mcuId} at ${pick.destDir}`);

    // Source folder may live outside the workspace — offer to open it.
    const inWorkspace = (vscode.workspace.workspaceFolders ?? []).some(
      (f) => pick.destDir.toLowerCase().startsWith(f.uri.fsPath.toLowerCase()),
    );
    if (!inWorkspace) {
      const open = await vscode.window.showInformationMessage(
        `工程已导入: ${path.basename(pick.destDir)}`,
        '打开工程',
      );
      if (open === '打开工程') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(pick.destDir), false);
      }
    } else {
      tbx.refresh();
    }
  } catch (e) {
    if (e instanceof Error && e.message) {
      void vscode.window.showErrorMessage(`导入工程失败: ${e.message}`);
    }
  }
}

export function registerImportCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [vscode.commands.registerCommand('mrsToolbox.importProject', () => runImportProject(tbx))];
}
