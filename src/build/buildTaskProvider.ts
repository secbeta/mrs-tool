import * as vscode from 'vscode';
import type { ToolboxContext } from '../toolbox';
import { loadProject } from '../project/projectModel';
import { makeBuildTask, type BuildKind } from './buildTasks';

/**
 * Provides the three build tasks for EVERY workspace project so they appear
 * under "Run Task…" — with several projects the user picks the task (named by
 * folder). The active project's build task is the default Build Task
 * (Ctrl+Shift+B).
 */
export class BuildTaskProvider implements vscode.TaskProvider {
  static readonly taskType = 'mrs-toolbox';

  constructor(private readonly tbx: ToolboxContext) {}

  async provideTasks(): Promise<vscode.Task[]> {
    const inst = this.tbx.installation ?? (await this.tbx.ensureInstallation());
    if (!inst) {
      return [];
    }
    const roots = await this.tbx.workspaceProjects();
    if (roots.length === 0) {
      return [];
    }
    const active = await this.tbx.activeProject();
    const tasks: vscode.Task[] = [];
    for (const root of roots) {
      const proj = await loadProject(root);
      if (!proj) {
        continue;
      }
      for (const kind of ['build', 'clean', 'rebuild'] as BuildKind[]) {
        tasks.push(
          makeBuildTask(
            inst,
            proj,
            root,
            kind,
            this.tbx.buildConfig,
            kind === 'build' && active?.root === root,
          ),
        );
      }
    }
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    // In-memory executions carry everything already; nothing to resolve.
    return undefined;
  }
}
