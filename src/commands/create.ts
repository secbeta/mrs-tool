import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ToolboxContext } from '../toolbox';
import { newProjectWizard, offerOpen } from '../project/wizard';
import { createProject } from '../project/projectCreator';
import { log } from '../util/log';

/** Blank template project: wizard → extract SDK zip → Makefile/IntelliSense. */
export async function runCreateNewProject(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  try {
    const pick = await newProjectWizard(inst);
    if (!pick) {
      return;
    }
    if (fs.existsSync(pick.destDir) && fs.readdirSync(pick.destDir).length > 0) {
      void vscode.window.showErrorMessage(`目标目录不为空: ${pick.destDir}`);
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'MRS Toolbox: 创建工程…' },
      () =>
        createProject(inst, {
          series: pick.series,
          mcuId: pick.mcuId,
          destDir: pick.destDir,
          createdFrom: 'template',
        }),
    );
    log(`created template project ${pick.mcuId} at ${pick.destDir}`);
    tbx.refresh();
    await offerOpen(pick.destDir);
  } catch (e) {
    if (e instanceof Error && e.message) {
      void vscode.window.showErrorMessage(`创建工程失败: ${e.message}`);
    }
    /* Cancelled has no message — silently return. */
  }
}

export function registerCreateCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mrsToolbox.createNewProject', () => runCreateNewProject(tbx)),
  ];
}
