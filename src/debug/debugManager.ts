import * as vscode from 'vscode';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';
import { generateDebugConfigs } from '../gen/vscodeConfigsGen';
import { runBuildTask } from '../build/buildTasks';
import { pathExists } from '../util/fsx';
import * as path from 'path';

const CORTEX_DEBUG_EXT = 'marus25.cortex-debug';

/** Ensure configs exist and a fresh build is present, then start debugging. */
export async function startDebugSession(
  inst: MrsInstallation,
  proj: MrsProject,
  projRoot: string,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('mrsToolbox');
  let provider = cfg.get<string>('debug.provider', 'auto');
  if (provider === 'auto') {
    provider = vscode.extensions.getExtension(CORTEX_DEBUG_EXT) ? 'cortex-debug' : 'cppdbg';
  }

  await generateDebugConfigs(projRoot, proj, inst);

  const elf = path.join(projRoot, proj.build.outputDir, proj.build.targetName + '.elf');
  if (!(await pathExists(elf))) {
    const pick = await vscode.window.showInformationMessage(
      '调试前需要先编译工程。',
      '编译并调试',
    );
    if (pick !== '编译并调试') {
      return;
    }
    const res = await runBuildTask(inst, proj, projRoot, 'build');
    if (res?.exitCode !== 0) {
      vscode.window.showErrorMessage('编译失败，已取消调试。');
      return;
    }
  }

  const wanted = `MRS: Debug ${proj.build.targetName} (${provider})`;
  const launch = vscode.workspace.getConfiguration('launch', vscode.Uri.file(projRoot));
  const configs = launch.get<{ name: string }[]>('configurations') ?? [];
  await vscode.debug.startDebugging(
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projRoot)) ?? undefined,
    configs.find((c) => c.name === wanted)?.name ?? wanted,
  );
}
