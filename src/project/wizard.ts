import * as vscode from 'vscode';
import * as path from 'path';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { SeriesInfo } from '../chipdb/types';
import { EXAMPLE_SERIES_MAP, MRS2_HOME_ENV } from '../constants';
import { pickFolder } from '../toolbox';

/** Single QuickPick step that can be cancelled at any point. */
class Cancelled extends Error {}

async function step<T>(p: PromiseLike<T | undefined>): Promise<T> {
  const v = await p;
  if (v === undefined) {
    throw new Cancelled();
  }
  return v;
}

export async function pickSeries(inst: MrsInstallation): Promise<SeriesInfo> {
  const items = inst.chipDb.series
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .map((s) => ({
      label: s.name,
      description: `${s.type} · ${s.mcus.length} MCU · ${s.toolchain.name}`,
      detail: s.isa.cpuFlags,
      series: s,
    }));
  const picked = await step(
    vscode.window.showQuickPick(items, {
      placeHolder: '选择芯片系列（架构 → 系列 → MCU）',
      matchOnDescription: true,
    }),
  );
  return picked.series;
}

export async function pickMcu(series: SeriesInfo): Promise<string> {
  if (series.mcus.length === 1) {
    return series.mcus[0].id;
  }
  const items = series.mcus.map((m) => ({ label: m.id }));
  const picked = await step(
    vscode.window.showQuickPick(items, { placeHolder: `${series.name}: 选择 MCU 型号` }),
  );
  return picked.label;
}

/** Ask for a project folder: name + parent directory → absolute destDir. */
export async function pickProjectLocation(
  defaultName: string,
  defaultParent?: string,
): Promise<{ destDir: string; name: string }> {
  const name = await step(
    vscode.window.showInputBox({
      prompt: '工程文件夹名',
      value: defaultName,
      validateInput: (v) => (/^[\w.-]+$/.test(v) ? undefined : '名称只能包含字母、数字、_ . -（避免中文/空格）'),
    }),
  );
  const parent = await step(pickFolder(vscode.Uri.file(defaultParent ?? path.join('.', name))));
  return { destDir: path.join(parent.fsPath, name), name };
}

/** Offer to open the freshly created project in the current window. */
export async function offerOpen(destDir: string): Promise<void> {
  const open = await vscode.window.showInformationMessage(
    `工程已创建：${path.basename(destDir)}`,
    '打开工程',
  );
  if (open === '打开工程') {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destDir), false);
  }
}

/**
 * Blank-project wizard: architecture-aware series list → MCU → name/location.
 * Returns undefined only when cancelled (throws Cancelled internally).
 */
export async function newProjectWizard(
  inst: MrsInstallation,
): Promise<{ destDir: string; series: SeriesInfo; mcuId: string } | undefined> {
  const series = await pickSeries(inst);
  const mcuId = await pickMcu(series);
  const { destDir } = await pickProjectLocation(mcuId);
  return { destDir, series, mcuId };
}

/**
 * Import wizard: pick the existing source folder, guess the series from its
 * name (or let the user choose), then treat it as the project root in place.
 */
export async function importWizard(
  inst: MrsInstallation,
): Promise<{ destDir: string; series: SeriesInfo; mcuId: string } | undefined> {
  const folder = await step(pickFolder(vscode.Uri.file(inst.root)));
  const dir = folder.fsPath;

  // Guess series from each path segment via the example-library map.
  const segments = dir.split(/[\\/]+/).map((s) => s.toUpperCase());
  let series: SeriesInfo | undefined;
  for (const seg of segments) {
    const mapping = EXAMPLE_SERIES_MAP[seg];
    if (mapping) {
      series = inst.chipDb.findSeries(mapping.series);
      if (series) {
        break;
      }
    }
  }
  if (!series) {
    series = await pickSeries(inst);
  } else {
    const keep = await vscode.window.showQuickPick(
      [
        { label: `使用识别到的系列 ${series.name}`, value: true },
        { label: '手动选择系列…', value: false },
      ],
      { placeHolder: '源码目录识别' },
    );
    if (keep === undefined) {
      return undefined;
    }
    if (!keep.value) {
      series = await pickSeries(inst);
    }
  }

  const mcuId = await pickMcu(series);
  return { destDir: dir, series, mcuId };
}

/** MRS2 install root selection: QuickPick over env/probe paths + browse. */
export async function pickMounriverRoot(current?: string): Promise<string | undefined> {
  const items: { label: string; description?: string; path?: string }[] = [];
  if (current) {
    items.push({ label: '当前配置', description: current, path: current });
  }
  const envRoot = process.env[MRS2_HOME_ENV];
  if (envRoot) {
    items.push({ label: `环境变量 ${MRS2_HOME_ENV}`, description: envRoot, path: envRoot });
  }
  items.push({ label: '浏览…', path: '' });
  const picked = await step(vscode.window.showQuickPick(items, { placeHolder: '选择 MounRiver Studio 2 安装目录' }));
  if (picked.path === '') {
    const folder = await step(pickFolder(vscode.Uri.file(current ?? 'C:\\')));
    return folder.fsPath;
  }
  return picked.path;
}
