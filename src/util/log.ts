import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('MRS Toolbox');
  }
  return channel;
}

export function log(msg: string): void {
  getLogChannel().appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
