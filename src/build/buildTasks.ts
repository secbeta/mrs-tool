import * as vscode from 'vscode';
import * as path from 'path';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';
import { makeEnv } from './makeEnv';
import { gccProblemMatcher } from './problemMatcher';

export type BuildKind = 'build' | 'clean' | 'rebuild';

const TASK_DEFS: Record<BuildKind, { name: string; target: string[] }> = {
  build: { name: 'Build Project', target: ['all'] },
  clean: { name: 'Clean Project', target: ['clean'] },
  rebuild: { name: 'Rebuild Project', target: ['clean', 'all'] },
};

/** In-memory task (source `mrs-toolbox`) — keeps PATH/env control internal. */
export function makeBuildTask(
  inst: MrsInstallation,
  proj: MrsProject,
  projRoot: string,
  kind: BuildKind,
  config: 'debug' | 'release',
  isDefaultBuild = false,
): vscode.Task {
  const def = TASK_DEFS[kind];
  const defType = 'mrs-toolbox';
  const execution = new vscode.ProcessExecution(inst.makeExe, [...def.target, `CONFIG=${config}`], {
    cwd: projRoot,
    env: makeEnv(inst, proj),
  });
  const task = new vscode.Task(
    { type: defType, kind, project: proj.build.targetName, config },
    vscode.TaskScope.Workspace,
    // Folder name, not target name: several projects share an MCU id.
    `${def.name} (${path.basename(projRoot)}, ${config})`,
    'MRS Toolbox',
    execution,
    kind === 'clean' ? [] : [gccProblemMatcher],
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };
  // The ACTIVE project's plain build is the default Build Task → Ctrl+Shift+B
  // builds it directly. The typings keep `isDefault` readonly but the runtime
  // honors it on the group instance for provided tasks; hosts that ignore it
  // degrade to a quick pick that still lists every project's tasks.
  if (kind === 'build' && isDefaultBuild) {
    const group = vscode.TaskGroup.Build;
    (group as { isDefault?: boolean }).isDefault = true;
    task.group = group;
  }
  return task;
}

/** Execute a build task and resolve when its process finishes. */
export async function runBuildTask(
  inst: MrsInstallation,
  proj: MrsProject,
  projRoot: string,
  kind: BuildKind,
  config: 'debug' | 'release' = 'debug',
): Promise<vscode.TaskProcessEndEvent | undefined> {
  const task = makeBuildTask(inst, proj, projRoot, kind, config);
  const execution = await vscode.tasks.executeTask(task);

  return new Promise((resolve) => {
    const d = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        d.dispose();
        resolve(e);
      }
    });
  });
}
