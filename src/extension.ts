import * as vscode from 'vscode';
import { ToolboxContext } from './toolbox';
import { ToolboxTree } from './ui/treeView';
import { ExamplesTree } from './ui/examplesTree';
import { StatusBar } from './ui/statusBar';
import { BuildTaskProvider } from './build/buildTaskProvider';
import { watchTaskCompletions } from './build/taskNotifier';
import { registerSetupCommands } from './commands/setup';
import { registerCreateCommands } from './commands/create';
import { registerExampleCommands } from './commands/examples';
import { registerImportCommands } from './commands/import';
import { registerBuildCommands } from './commands/build';
import { registerFlashCommands } from './commands/flash';
import { registerDebugCommands } from './commands/debug';
import { registerMiscCommands } from './commands/misc';
import { registerSerialCommands } from './commands/serial';
import { ConfigPage } from './ui/configPage';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tbx = new ToolboxContext(context);
  const home = new ToolboxTree(tbx);
  const examples = new ExamplesTree(tbx);
  const status = new StatusBar(tbx);
  const configPage = new ConfigPage(tbx);
  configPage.register(context);

  // Silent background detect (no error popups) — sets context keys for the
  // welcome pages and the status bar.
  void tbx.ensureInstallation().then(() => examples.rescan());
  void tbx.activeProject();

  const registrations: vscode.Disposable[] = [
    tbx,
    status,
    vscode.window.createTreeView('mrsToolbox.home', { treeDataProvider: home }),
    vscode.window.createTreeView('mrsToolbox.examples', { treeDataProvider: examples }),
    vscode.tasks.registerTaskProvider(
      BuildTaskProvider.taskType,
      new BuildTaskProvider(tbx),
    ),
    ...registerSetupCommands(tbx),
    ...registerCreateCommands(tbx),
    ...registerExampleCommands(tbx, examples),
    ...registerImportCommands(tbx),
    ...registerBuildCommands(tbx),
    ...registerFlashCommands(tbx),
    ...registerDebugCommands(tbx),
    ...registerMiscCommands(tbx),
    ...registerSerialCommands(tbx),
    watchTaskCompletions(),
    // Keep view/state fresh when folders or settings change.
    vscode.workspace.onDidChangeWorkspaceFolders(() => tbx.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mrsToolbox')) {
        if (e.affectsConfiguration('mrsToolbox.mounriverStudioPath')) {
          void tbx.ensureInstallation(true);
        }
        if (
          e.affectsConfiguration('mrsToolbox.examplesDirectory') ||
          e.affectsConfiguration('mrsToolbox.examplesDirectories')
        ) {
          void examples.rescan();
        }
        tbx.refresh();
      }
    }),
  ];
  context.subscriptions.push(...registrations);
}

export function deactivate(): void {
  /* everything lives in context.subscriptions */
}
