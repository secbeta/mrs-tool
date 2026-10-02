import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ToolboxContext } from '../toolbox';
import { pickFolder } from '../toolbox';
import type { ExamplesTree } from '../ui/examplesTree';
import { pickExample, exampleProjectName } from '../ui/examplesTree';
import type { ExampleEntry } from '../examples/exampleLibrary';
import {
  addLibraryDir,
  libraryDirs,
  libraryLabel,
  removeLibraryDir,
  scanAllLibraries,
  scanCount,
} from '../examples/libraryManager';
import { pickMcu, pickProjectLocation, offerOpen, pickSeries } from '../project/wizard';
import { createProject } from '../project/projectCreator';
import { writeExampleSkills } from '../gen/skillGen';
import { log } from '../util/log';

/**
 * Create a buildable project from a library example. Called from the examples
 * tree (arg = ExampleEntry) or the palette (QuickPick over all libraries).
 * Recipe: SDK template zip as shared-source base ∪ example app sources.
 */
export async function runCreateFromExample(
  tbx: ToolboxContext,
  arg?: ExampleEntry,
): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }

  const dirs = libraryDirs();
  if (dirs.length === 0) {
    const add = await vscode.window.showWarningMessage(
      '尚未配置例程库。先添加一个例程库目录（可添加多个）。',
      '添加例程库…',
      '打开配置页面',
    );
    if (add === '添加例程库…') {
      await runAddExamplesLibrary();
    } else if (add === '打开配置页面') {
      void vscode.commands.executeCommand('mrsToolbox.configure');
    }
    return;
  }

  let entry = arg;
  if (!entry) {
    entry = await pickExample(scanAllLibraries());
    if (!entry) {
      return;
    }
  }

  try {
    let series = inst.chipDb.findSeries(entry.series);
    if (!series) {
      series = await pickSeries(inst);
    }
    const mcuId = await pickMcu(series);
    const { destDir } = await pickProjectLocation(
      exampleProjectName(entry, mcuId),
      fs.existsSync(entry.path) ? fs.realpathSync.native(entry.path) : entry.path,
    );
    if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
      void vscode.window.showErrorMessage(`目标目录不为空: ${destDir}`);
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `MRS Toolbox: 从例程 ${entry.name} 创建工程…` },
      () =>
        createProject(inst, {
          series,
          mcuId,
          destDir,
          createdFrom: 'example',
          exampleDir: entry!.path,
          searchRoots: libraryDirs(),
        }),
    );
    log(`created project from example ${entry!.name} (${entry!.path}) at ${destDir}`);
    tbx.refresh();
    await offerOpen(destDir);
  } catch (e) {
    if (e instanceof Error && e.message) {
      void vscode.window.showErrorMessage(`从例程创建工程失败: ${e.message}`);
    }
  }
}

/**
 * Add an examples library directory (like installing an extra ADF library):
 * pick a folder, sanity-scan it, persist to `mrsToolbox.examplesDirectories`.
 */
export async function runAddExamplesLibrary(): Promise<boolean> {
  const dirs = libraryDirs();
  const uri = await pickFolder(
    dirs.length > 0 ? vscode.Uri.file(dirs[dirs.length - 1]) : undefined,
  );
  if (!uri) {
    return false;
  }
  const dir = uri.fsPath;
  if (dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) {
    void vscode.window.showInformationMessage(`例程库已存在: ${libraryLabel(dir)}`);
    return true;
  }

  const count = scanCount(dir);
  if (count === 0) {
    const force = await vscode.window.showWarningMessage(
      `在 ${dir} 未识别到例程（期望 <芯片>/EVT/EXAM/<分类>/<例程> 结构）。仍要添加该目录吗？`,
      '仍然添加',
      '取消',
    );
    if (force !== '仍然添加') {
      return false;
    }
  }

  await addLibraryDir(dir);
  void vscode.commands.executeCommand('mrsToolbox.refreshExamples');
  void vscode.window.showInformationMessage(
    `已添加例程库 ${libraryLabel(dir)}${count > 0 ? `（识别到 ${count} 个例程）` : ''}。`,
  );
  return true;
}

/** Remove a library — from the tree node context (arg = dir) or a QuickPick. */
export async function runRemoveExamplesLibrary(arg?: string): Promise<void> {
  const dirs = libraryDirs();
  if (dirs.length === 0) {
    void vscode.window.showInformationMessage('当前没有已配置的例程库。');
    return;
  }

  let dir = arg;
  if (!dir) {
    const picked = await vscode.window.showQuickPick(
      dirs.map((d) => ({ label: libraryLabel(d), description: d, dir: d })),
      { placeHolder: '选择要移除的例程库（只从扩展中移除，不删除文件）' },
    );
    if (!picked) {
      return;
    }
    dir = picked.dir;
  }

  await removeLibraryDir(dir);
  void vscode.commands.executeCommand('mrsToolbox.refreshExamples');
  void vscode.window.showInformationMessage(`已移除例程库 ${libraryLabel(dir)}（目录本身未改动）。`);
}

/**
 * 把例程库结构沉淀成 AI skill（每库一个，写到 aiSkillsDir，默认
 * ~/.claude/skills —— Claude Code 自动发现，其它 AI 可直接读）。
 * 例程库增删后重跑即同步；只覆盖本工具生成的（带标记）文件。
 */
export async function runGenerateAiSkills(): Promise<void> {
  const dirs = libraryDirs();
  if (dirs.length === 0) {
    const add = await vscode.window.showWarningMessage(
      '尚未配置例程库，没有可生成的内容。先添加一个例程库目录。',
      '添加例程库…',
    );
    if (add === '添加例程库…') {
      await runAddExamplesLibrary();
    }
    return;
  }
  const configured = vscode.workspace.getConfiguration('mrsToolbox').get<string>('aiSkillsDir', '');
  const outDir = configured
    ? configured.replace(/^~(?=$|[\\/])/, require('os').homedir())
    : require('path').join(require('os').homedir(), '.claude', 'skills');

  const libs = scanAllLibraries().filter((l) => l.examples.length > 0);
  const version = require('../../package.json').version as string;
  const r = await writeExampleSkills(libs, outDir, version);
  const total = libs.reduce((n, l) => n + l.examples.length, 0);
  void vscode.window.showInformationMessage(
    `AI skills 已生成: ${libs.length} 库 / ${total} 例程 → ${outDir}` +
      (r.removed.length ? `（清理 ${r.removed.length} 个陈旧 skill）` : '') +
      (r.skippedEdited.length ? `（${r.skippedEdited.length} 个手改过的未覆盖）` : ''),
  );
}

export function registerExampleCommands(tbx: ToolboxContext, tree: ExamplesTree): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mrsToolbox.createProjectFromExample', (arg) =>
      runCreateFromExample(tbx, arg as ExampleEntry | undefined),
    ),
    vscode.commands.registerCommand('mrsToolbox.refreshExamples', () => tree.rescan()),
    vscode.commands.registerCommand('mrsToolbox.addExamplesLibrary', () =>
      runAddExamplesLibrary(),
    ),
    vscode.commands.registerCommand('mrsToolbox.removeExamplesLibrary', (arg) =>
      runRemoveExamplesLibrary(arg as string | undefined),
    ),
    vscode.commands.registerCommand('mrsToolbox.generateAiSkills', () =>
      runGenerateAiSkills(),
    ),
  ];
}
