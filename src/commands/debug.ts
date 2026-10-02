import * as vscode from 'vscode';
import type { ToolboxContext } from '../toolbox';
import { startDebugSession } from '../debug/debugManager';

export async function runDebug(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  try {
    await startDebugSession(req.inst, req.proj, req.root);
  } catch (e) {
    void vscode.window.showErrorMessage(`启动调试失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerDebugCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [vscode.commands.registerCommand('mrsToolbox.debug', () => runDebug(tbx))];
}
