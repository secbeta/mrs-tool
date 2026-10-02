import * as vscode from 'vscode';

const TASK_TYPE = 'mrs-toolbox';

const VERBS: Record<string, string> = {
  build: '编译',
  clean: '清理',
  rebuild: '重建',
};

/**
 * Bottom-right toast whenever a MRS Toolbox task process finishes. Watching
 * the task system (instead of the command handlers) covers every entry
 * point: F7/Shift+F7 commands, Ctrl+Shift+B (default Build Task) and manual
 * "Run Task…" — they all execute the same tasks.
 */
export function watchTaskCompletions(): vscode.Disposable {
  const startedAt = new WeakMap<vscode.TaskExecution, number>();

  const onStart = vscode.tasks.onDidStartTaskProcess((e) =>
    startedAt.set(e.execution, Date.now()),
  );

  const onEnd = vscode.tasks.onDidEndTaskProcess((e) => {
    const def = e.execution.task.definition as {
      type?: string;
      kind?: string;
      project?: string;
      config?: string;
    };
    if (def?.type !== TASK_TYPE) {
      return;
    }
    const verb = VERBS[def.kind ?? ''] ?? '任务';
    const label = def.project ? `: ${def.project}` : '';
    const config = def.config ? ` · ${def.config}` : '';
    const started = startedAt.get(e.execution);
    const secs = started ? ` · ${((Date.now() - started) / 1000).toFixed(1)}s` : '';
    if (e.exitCode === 0) {
      void vscode.window.showInformationMessage(`${verb}完成${label}${config}${secs}`);
    } else {
      void vscode.window.showErrorMessage(
        `${verb}失败 (exit ${e.exitCode ?? '?'})${label}${config} — 详情见终端面板。`,
      );
    }
  });

  return vscode.Disposable.from(onStart, onEnd);
}
