import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from './projectModel';
import { finalizeProject, findLinkerScript } from './projectCreator';
import { extractTemplateZip } from './templateZip';
import { suggestChipDefine } from './projectScanner';
import { readZipTemplateManifest } from '../chipdb/chipDatabase';
import { parseProjectFile } from '../examples/cprojectParser';
import { generateDebugConfigs } from '../gen/vscodeConfigsGen';
import { readJsonIfExists, writeIfChanged } from '../util/fsx';

/**
 * 同系列切换 MCU 型号（如 CH582F → CH582M）。
 *
 * 实测结论（SDK v2.8，见 CHANGELOG 0.2.9）：同系列各型号 ZIP 的源码/外设库
 * 逐字节相同，差异只有 —— ①`.project/.launch/.template` 元数据；②内存不同
 * 时 `Ld/Link.ld`（CH32V203、CH585）或换名的 `LD/<型号>.ld`（ARM CH32F103）；
 * ③内核派生不同时 Startup 排除表 + 设备头宏（V203 D6↔D8）。因此切换 =
 * 模板文件三方合并（旧模板为基准，用户改过的绝不覆盖）+ 元数据原地改 +
 * 重新生成。跨系列（外设库/ISA 全不同）不支持，提示新建工程。
 */

/** 面向用户的"不支持/参数错"，UI/CLI 按 warning 处理而非 bug。 */
export class McuSwitchError extends Error {}

export interface McuSwitchResult {
  fromMcuId: string;
  toMcuId: string;
  /** targetName/flash.image 是否跟随了新型号（用户自定义名则不动）。 */
  targetRenamed: boolean;
  /** 从新模板覆盖/新增的文件（工程相对路径）。 */
  updated: string[];
  /** 型号专属文件被移除（如 ARM 每型号一个 .ld，旧名已不存在于新模板）。 */
  removed: string[];
  /** 用户改过且新旧模板有差异 → 保留了用户版本。 */
  conflicts: string[];
  notes: string[];
}

export async function switchMcu(
  inst: MrsInstallation,
  projRoot: string,
  proj: MrsProject,
  newMcuId: string,
): Promise<McuSwitchResult> {
  const series = inst.chipDb.findSeries(proj.mcu.series);
  if (!series) {
    throw new McuSwitchError(`系列 ${proj.mcu.series} 不在当前芯片库中（SDK 有变动？重跑 Setup）`);
  }
  const oldMcu = series.mcus.find((m) => m.id.toLowerCase() === proj.mcu.mcuId.toLowerCase());
  if (!oldMcu) {
    throw new McuSwitchError(`当前型号 ${proj.mcu.mcuId} 不在系列 ${series.name} 的芯片库中，无法安全切换`);
  }
  const newMcu = series.mcus.find((m) => m.id.toLowerCase() === newMcuId.toLowerCase());
  if (!newMcu) {
    const other = inst.chipDb.series.find((s) =>
      s.mcus.some((m) => m.id.toLowerCase() === newMcuId.toLowerCase()),
    );
    throw new McuSwitchError(
      other
        ? `跨系列切换（${series.name} → ${other.name}）不支持：外设库/启动文件/ISA 全不同，请从模板新建工程`
        : `系列 ${series.name} 中没有型号 ${newMcuId}（可用型号见 mrs-toolbox mcus --series ${series.name}）`,
    );
  }
  if (newMcu.id === oldMcu.id) {
    throw new McuSwitchError(`工程已在使用 ${oldMcu.id}`);
  }

  // 特殊型号防护：如 CH32V203CCT 实为 CH32V205 外设库 —— `Mcu Type` 不同即拒绝。
  const oldType = readZipTemplateManifest(oldMcu.zipPath)?.mcuType;
  const newType = readZipTemplateManifest(newMcu.zipPath)?.mcuType;
  if (oldType && newType && oldType !== newType) {
    throw new McuSwitchError(
      `${newMcu.id} 的外设库类型是 ${newType}（当前工程 ${oldType}），差异过大，请从模板新建工程`,
    );
  }

  const result: McuSwitchResult = {
    fromMcuId: oldMcu.id,
    toMcuId: newMcu.id,
    targetRenamed: proj.build.targetName === oldMcu.id,
    updated: [],
    removed: [],
    conflicts: [],
    notes: [],
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-switch-'));
  try {
    const newDir = path.join(tmp, 'new');
    const oldDir = path.join(tmp, 'old');
    extractTemplateZip(newMcu.zipPath, newDir);
    extractTemplateZip(oldMcu.zipPath, oldDir);
    const newFiles = collectTemplateFiles(newDir);
    const oldFiles = collectTemplateFiles(oldDir);
    overlayTemplateFiles(projRoot, oldFiles, newFiles, result);

    // Startup 排除表跟随新模板的 .cproject（D6↔D8 互斥启动文件）；
    // 非 Startup 的用户排除（如 estim 排掉的 Debug/debug.c）原样保留。
    proj.build.excludedPaths = [
      ...new Set([
        ...parseProjectFile(newDir).excludedPaths,
        ...proj.build.excludedPaths.filter((p) => !/^Startup(\/|$)/i.test(p)),
      ]),
    ];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 链接脚本被移除（ARM 每型号一个 .ld 文件名）→ 重定位到新模板的。
  if (result.removed.includes(proj.build.linkerScript)) {
    const linkerAbs = findLinkerScript(projRoot);
    const rel = linkerAbs ? path.relative(projRoot, linkerAbs).split(path.sep).join('/') : undefined;
    if (!rel) {
      throw new McuSwitchError(`旧链接脚本 ${proj.build.linkerScript} 已移除且找不到替代的 .ld 文件`);
    }
    proj.build.linkerScript = rel;
    result.notes.push(`链接脚本 → ${rel}`);
  }

  // ---- 元数据（原地改：用户自定义的编译选项/排除路径/未知字段全保留）----
  proj.mcu.mcuId = newMcu.id;
  if (newType) {
    proj.mcu.mcuType = newType;
  }
  if (result.targetRenamed) {
    proj.build.targetName = newMcu.id;
    proj.flash.image = `obj/${newMcu.id}.hex`;
  }
  // CHIP_ID 替换而非追加（CH582F→CH582M 值恰好不变；→CH583M 会变）。
  const chipDefine = suggestChipDefine(newMcu.id, series.name);
  if (chipDefine) {
    const i = proj.build.defines.findIndex((d) => d.startsWith('CHIP_ID='));
    if (i >= 0) {
      proj.build.defines[i] = chipDefine;
    }
  }

  // ---- 重新生成 + 清理 ----
  await finalizeProject(inst, projRoot, proj);
  await generateDebugConfigs(projRoot, proj, inst);
  if (result.targetRenamed) {
    await pruneLaunchEntries(projRoot, result.fromMcuId);
  }
  renameInFile(path.join(projRoot, '.project'), result.fromMcuId, result.toMcuId);
  renameInFile(path.join(projRoot, '.launch'), result.fromMcuId, result.toMcuId);
  // make 不感知 flags/型号变化，旧目标的 .o/.hex 会静默混链 —— 整目录清掉。
  fs.rmSync(path.join(projRoot, proj.build.outputDir), { recursive: true, force: true });
  result.notes.push(`已清空 ${proj.build.outputDir}/，请重新编译`);
  return result;
}

/**
 * 模板文件清单：posix 相对路径 → 解压后的绝对路径。
 * 跳过 User/（用户应用代码）与点文件（.cproject 由模型同步，.project/.launch
 * 单独做型号字符串替换），跳过 obj/。
 */
function collectTemplateFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === 'User' || e.name === 'obj' || e.name.startsWith('.')) {
          continue;
        }
        walk(path.join(dir, e.name), relPath);
      } else if (!e.name.startsWith('.')) {
        out.set(relPath, path.join(dir, e.name));
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * 三方合并：基准 = 旧模板版本，目标 = 工程现状，来者 = 新模板版本。
 * - 现状 == 旧模板 → 允许被新模板覆盖（同内容则 no-op）；
 * - 现状 != 旧模板（用户改过）→ 保留用户版本，记入 conflicts；
 * - 新增文件若定义 main()（换型号可能带回模板示例 main，与例程工程的
 *   main 冲突）→ 跳过；用户删过的文件不复活。
 * - 旧模板有、新模板没有、且工程 == 旧模板 → 删除（ARM 换名 .ld 等）。
 */
function overlayTemplateFiles(
  projRoot: string,
  oldFiles: Map<string, string>,
  newFiles: Map<string, string>,
  result: McuSwitchResult,
): void {
  const read = (p: string): Buffer => fs.readFileSync(p);
  const same = (a: string | undefined, b: Buffer | undefined): boolean =>
    !!a && !!b && read(a).equals(b);

  for (const [rel, srcAbs] of newFiles) {
    const dest = path.join(projRoot, ...rel.split('/'));
    const incoming = read(srcAbs);
    if (fs.existsSync(dest)) {
      const current = read(dest);
      if (current.equals(incoming)) {
        continue;
      }
      if (same(oldFiles.get(rel), current)) {
        fs.writeFileSync(dest, incoming);
        result.updated.push(rel);
      } else {
        result.conflicts.push(rel);
      }
      continue;
    }
    if (oldFiles.has(rel)) {
      continue; // 工程里没有（用户删过 / 例程剥离过）—— 不复活
    }
    if (/\.c$/i.test(rel) && /\b(?:int|void)\s+main\s*\(/.test(incoming.toString('utf-8'))) {
      continue; // 新增的模板示例 main，避免与工程现有 main 重复链接
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, incoming);
    result.updated.push(rel);
  }

  for (const [rel, srcAbs] of oldFiles) {
    if (newFiles.has(rel)) {
      continue;
    }
    const dest = path.join(projRoot, ...rel.split('/'));
    if (!fs.existsSync(dest)) {
      continue;
    }
    if (read(dest).equals(read(srcAbs))) {
      fs.rmSync(dest);
      result.removed.push(rel);
      pruneEmptyDirs(path.dirname(dest), projRoot);
    } else {
      result.notes.push(`保留新模板已移除的 ${rel}（内容被修改过）`);
    }
  }
}

function pruneEmptyDirs(dir: string, stop: string): void {
  let cur = dir;
  while (cur.length > stop.length) {
    try {
      fs.rmdirSync(cur); // 仅空目录可删，非空抛错即止
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

/** 删掉旧 targetName 的调试配置（名字里嵌了型号，改名后会永久堆积）。 */
async function pruneLaunchEntries(projRoot: string, oldTarget: string): Promise<void> {
  const file = path.join(projRoot, '.vscode', 'launch.json');
  const doc = await readJsonIfExists<{ configurations?: Record<string, unknown>[] }>(file);
  if (!doc?.configurations?.length) {
    return;
  }
  const prefix = `MRS: Debug ${oldTarget} (`;
  const kept = doc.configurations.filter((c) => typeof c.name !== 'string' || !c.name.startsWith(prefix));
  if (kept.length !== doc.configurations.length) {
    doc.configurations = kept;
    await writeIfChanged(file, JSON.stringify(doc, null, 2) + '\n');
  }
}

/** `.project`/`.launch` 里的型号字符串（工程名、elf 路径）原地替换。 */
function renameInFile(file: string, from: string, to: string): void {
  try {
    if (!fs.existsSync(file)) {
      return;
    }
    const text = fs.readFileSync(file, 'utf-8');
    if (text.includes(from)) {
      fs.writeFileSync(file, text.split(from).join(to));
    }
  } catch {
    /* MRS2 互操作文件，失败不阻断切换 */
  }
}
