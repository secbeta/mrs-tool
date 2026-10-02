import * as vscode from 'vscode';
import type { ToolboxContext } from '../toolbox';
import { runBuildTask, type BuildKind } from '../build/buildTasks';
import { finalizeProject } from '../project/projectCreator';
import { generateIntellisense } from '../gen/intellisenseGen';
import { findWorkspaceProjects } from '../project/projectModel';
import { switchMcu, McuSwitchError, type McuSwitchResult } from '../project/mcuSwitcher';
import { readZipTemplateManifest } from '../chipdb/chipDatabase';
import { pathExists } from '../util/fsx';
import * as path from 'path';
import { PROJECT_MARKER } from '../constants';

/** Build/clean/rebuild via the make task with the active CONFIG. */
export async function runBuild(tbx: ToolboxContext, kind: BuildKind): Promise<boolean> {
  const req = await tbx.require();
  if (!req) {
    return false;
  }
  const ev = await runBuildTask(req.inst, req.proj, req.root, kind, tbx.buildConfig);
  // Completion/failure toast comes from watchTaskCompletions (task system),
  // which also covers Ctrl+Shift+B and manual Run Task….
  return ev?.exitCode === 0;
}

/** debug | release toggle persisted per workspace. */
export async function runSetBuildConfig(tbx: ToolboxContext): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'debug', description: '-Og -g3（默认，可调试）' },
      { label: 'release', description: '-Os -g（优化体积）' },
    ],
    { placeHolder: `当前: ${tbx.buildConfig}` },
  );
  if (picked) {
    tbx.setBuildConfig(picked.label as 'debug' | 'release');
  }
}

/**
 * 同系列切换 MCU 型号（CH582F → CH582M）。跨系列不支持（外设库/ISA 全不同，
 * 提示新建工程）。同系列实测仅元数据与 Link.ld 有差异，模板文件三方合并
 * 保护用户改动（见 src/project/mcuSwitcher.ts）。
 */
export async function runSwitchMcu(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  const { inst, root, proj } = req;
  const series = inst.chipDb.findSeries(proj.mcu.series);
  if (!series) {
    void vscode.window.showErrorMessage(`系列 ${proj.mcu.series} 不在芯片库中，无法切换型号。`);
    return;
  }
  if (series.mcus.length <= 1) {
    void vscode.window.showInformationMessage(`系列 ${series.name} 只有一种型号，无需切换。`);
    return;
  }
  const items = series.mcus.map((m) => ({
    label: `${m.id === proj.mcu.mcuId ? '$(check) ' : ''}${m.id}`,
    description: readZipTemplateManifest(m.zipPath)?.description ?? '',
    id: m.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `切换 MCU 型号（当前 ${proj.mcu.mcuId} · 仅限 ${series.name} 同系列；跨系列请新建工程）`,
  });
  if (!picked || picked.id === proj.mcu.mcuId) {
    return;
  }
  try {
    const r = await switchMcu(inst, root, proj, picked.id);
    tbx.refresh();
    summarizeSwitch(r);
  } catch (e) {
    if (e instanceof McuSwitchError) {
      void vscode.window.showWarningMessage(e.message);
    } else {
      void vscode.window.showErrorMessage(`切换型号失败: ${(e as Error).message}`);
    }
  }
}

function summarizeSwitch(r: McuSwitchResult): void {
  const parts = [`已切换 ${r.fromMcuId} → ${r.toMcuId}`];
  if (r.updated.length) {
    parts.push(`更新 ${r.updated.length} 个模板文件`);
  }
  if (r.conflicts.length) {
    parts.push(`${r.conflicts.length} 个文件保留你的修改: ${r.conflicts.slice(0, 3).join('、')}${r.conflicts.length > 3 ? '…' : ''}`);
  }
  parts.push('已重新生成构建文件并清空 obj/');
  void vscode.window.showInformationMessage(parts.join('；') + '。');
}

/** Re-render Makefile + IntelliSense from the marker (after manual edits). */
export async function runGenerateBuildFiles(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  await finalizeProject(req.inst, req.root, req.proj);
  void vscode.window.showInformationMessage(
    '已重新生成 Makefile / IntelliSense 配置，并同步 .cproject（MRS2 端编译需要的头文件路径/宏/链接脚本以 .mrs-project.json 为准）。',
  );
}

export async function runGenerateIntellisense(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  await generateIntellisense(req.root, req.proj, req.inst);
  void vscode.window.showInformationMessage('已生成 .vscode/c_cpp_properties.json。');
}

/** Multi-project: choose which marker-bearing folder commands act on. */
export async function runSelectProject(tbx: ToolboxContext): Promise<void> {
  const roots = await findWorkspaceProjects();
  if (roots.length === 0) {
    void vscode.window.showInformationMessage(
      '当前工作区没有 MRS Toolbox 工程。请先新建、从例程创建或导入工程。',
    );
    return;
  }
  if (roots.length === 1) {
    tbx.setActiveProject(roots[0]);
    return;
  }
  const root = await tbx.pickProjectRoot(roots);
  if (root) {
    tbx.setActiveProject(root);
  }
}

export function registerBuildCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mrsToolbox.build', () => runBuild(tbx, 'build')),
    vscode.commands.registerCommand('mrsToolbox.clean', () => runBuild(tbx, 'clean')),
    vscode.commands.registerCommand('mrsToolbox.rebuild', () => runBuild(tbx, 'rebuild')),
    vscode.commands.registerCommand('mrsToolbox.setBuildConfiguration', () => runSetBuildConfig(tbx)),
    vscode.commands.registerCommand('mrsToolbox.generateBuildFiles', () => runGenerateBuildFiles(tbx)),
    vscode.commands.registerCommand('mrsToolbox.switchMcu', () => runSwitchMcu(tbx)),
    vscode.commands.registerCommand('mrsToolbox.generateIntellisenseConfig', () => runGenerateIntellisense(tbx)),
    vscode.commands.registerCommand('mrsToolbox.selectProject', () => runSelectProject(tbx)),
  ];
}

/** Guard helper for commands that need an existing marker in the workspace. */
export async function hasWorkspaceProject(): Promise<boolean> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (await pathExists(path.join(f.uri.fsPath, PROJECT_MARKER))) {
      return true;
    }
  }
  return false;
}
