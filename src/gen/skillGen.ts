/**
 * skillGen.ts — 把例程库结构沉淀为 AI 可加载的 skill 文件。
 *
 * 动机：每个新 AI 会话都要重新扫描例程库、重新理解三种例程形态——这些知识
 * 是静态的。本模块把「库结构知识 + 全例程目录 + 建工程命令」渲染成 Claude
 * Code skill（`~/.claude/skills/<name>/SKILL.md`，其它 AI 也能直接读），
 * 例程库增删后重新生成即同步。
 *
 * 粒度：**每个例程库一个 skill**（不是每个例程一个——237 个例程会灌爆每个
 * AI 会话的 skill 列表）。
 *
 * 结构（0.2.17 起，防读取截断）：SKILL.md 只做**路由**——形态知识 + 建工程
 * 命令 + 芯片分发表（表在最前部，截断再狠也看得到库里有哪些芯片）；每个芯
 * 片的例程清单放独立分表 `refs/<芯片slug>.md`。此前 455 行单文件按芯片顺
 * 序铺开，只读文件开头 N 行的 AI 消费端只能看到第一块芯片的例程。
 * 本模块不 import vscode —— 渲染与写入均为纯函数，命令层/CLI 各自喂数。
 */
import * as fs from 'fs';
import * as path from 'path';
import { writeIfChanged } from '../util/fsx';
import type { ExampleLibrary, ExampleEntry } from '../examples/exampleLibrary';

const MARKER = '<!-- mrs-toolbox:generated SKILL.md -->';
const PREFIX = 'mrs-examples-';

/** 三种例程形态的结构知识（每个 skill 正文都带，AI 读一个文件即可不再扫库）。 */
const STYLE_NOTES = `## 例程形态（识别与结构差异）

| 形态 | 识别 | 目录结构 | 建工程时 mrs-toolbox 会做什么 |
|---|---|---|---|
| mrs2 | 有 .wvproj（常伴 .cproject） | 仅 User/ 有应用源码 | 从 MRS2 SDK 模板解公共源码底座（Peripheral/Startup/Ld…）再叠加 User/ |
| mrs1 | 有 .cproject 无 .wvproj | 自带完整源码（APP/Startup/Ld） | 缺目录时从库级 <芯片>/EVT/SRC 共享池补齐 |
| keil | 有 .uvprojx/.uvproj | 应用源码平铺 | 同 mrs2 底座方式，平铺文件拷入 |
| plain | 只有 .c 文件 | 纯源码目录 | 同 keil；defines 需人工补（如 CH5xx 的 CHIP_ID） |

## 从例程建工程（可直接执行）

\`\`\`bash
node <mrs-toolbox>/bin/mrs-toolbox.js create --mcu <型号> --dir <目标目录> --from-example "<例程绝对路径>"
node <mrs-toolbox>/bin/mrs-toolbox.js build <目标目录>
\`\`\`

- 型号：先 \`mrs-toolbox mcus --series <目录里的 series>\` 查该系列可用型号
  （例：series CH58X → CH582M / CH582F / CH583M…）
- 例程库增删后重跑 \`mrs-toolbox skills\` 刷新本文件`;

/** 库名 → skill 目录名：mrs-examples-<slug>；同名库冲突时拼路径散列。 */
export function skillDirName(root: string, allRoots: string[]): string {
  const slug = (path.basename(root) || 'lib')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'lib';
  let name = PREFIX + slug;
  const clash = allRoots.filter((r) => r.toLowerCase() !== root.toLowerCase() && name === PREFIX + (path.basename(r) || 'lib').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  if (clash.length > 0) {
    name += '-' + hash32(root.toLowerCase()).toString(16);
  }
  return name;
}

function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function chipSummary(lib: ExampleLibrary): string {
  const chips = new Map<string, { series: string; type: string; n: number }>();
  for (const e of lib.examples) {
    const cur = chips.get(e.chipFolder) ?? { series: e.series, type: e.type, n: 0 };
    cur.n++;
    chips.set(e.chipFolder, cur);
  }
  return [...chips.entries()]
    .map(([folder, v]) => `${folder}→${v.series}(${v.type})×${v.n}`)
    .join('、');
}

/** 例程按芯片目录分组（保持扫描顺序，即目录序）。 */
function groupByChip(lib: ExampleLibrary): Map<string, ExampleEntry[]> {
  const byChip = new Map<string, ExampleEntry[]>();
  for (const e of lib.examples) {
    const list = byChip.get(e.chipFolder) ?? [];
    list.push(e);
    byChip.set(e.chipFolder, list);
  }
  return byChip;
}

/** 芯片目录名 → 分表文件 slug：CH32F103 → ch32f103（清洗规则同 skillDirName）。 */
export function chipRefSlug(folder: string): string {
  return folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'chip';
}

/** 渲染单个芯片的例程分表（refs/<slug>.md，纯函数，单测覆盖）。 */
export function renderChipRef(folder: string, list: ExampleEntry[]): string {
  const first = list[0];
  const sections: string[] = [];
  sections.push(MARKER);
  sections.push(`# ${folder} 例程（series ${first.series} · ${first.type} · ${list.length} 个）`);
  sections.push('> 本 skill 的 SKILL.md 有形态知识与建工程命令；例程增删后重跑 `mrs-toolbox skills` 刷新。\n');
  let cat = '';
  for (const e of [...list].sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name))) {
    if (e.category !== cat) {
      cat = e.category;
      sections.push(`\n**${cat || '（根）'}**\n`);
    }
    sections.push(`- ${e.name}（${e.style}）— \`${e.path}\``);
  }
  return sections.join('\n') + '\n';
}

/** 渲染单个例程库的 SKILL.md 路由（纯函数，单测覆盖；例程清单在 refs/ 分表）。 */
export function renderExampleSkill(lib: ExampleLibrary, version: string, allRoots: string[] = [lib.root]): string {
  const name = skillDirName(lib.root, allRoots);
  const desc =
    `WCH 例程库 ${path.basename(lib.root)}（${lib.examples.length} 个例程：${chipSummary(lib)}）` +
    '的结构速查与建工程命令 — 涉及 WCH 例程浏览/从例程建工程时先读本 skill。由 mrs-toolbox 生成。';

  const byChip = groupByChip(lib);

  const sections: string[] = [];
  sections.push(`---\nname: ${name}\ndescription: ${desc}\n---`);
  sections.push(MARKER);
  sections.push(`# 例程库速查：${path.basename(lib.root)}\n\n- 库根目录：\`${lib.root}\`（例程增删后重跑 \`mrs-toolbox skills\` 刷新）`);
  sections.push(`- 由 mrs-toolbox v${version} 生成于 ${new Date().toISOString().slice(0, 10)}\n`);
  sections.push('## 芯片分表（本文件不内嵌例程清单，按芯片读对应分表）\n');
  sections.push('| 芯片目录 | series | 类型 | 例程数 | 分表文件 |');
  sections.push('|---|---|---|---|---|');
  for (const [folder, list] of byChip) {
    const first = list[0];
    sections.push(`| ${folder} | ${first.series} | ${first.type} | ${list.length} | \`refs/${chipRefSlug(folder)}.md\` |`);
  }
  sections.push('\n每个分表内例程按分类（GPIO、USART、BLE…）列出名称、形态与**绝对路径**。\n');
  sections.push(STYLE_NOTES);

  return sections.join('\n') + '\n';
}

export interface SkillsWriteResult {
  written: string[];
  /** 内容未变（已是最新）。 */
  kept: string[];
  /** 手改过（生成标记消失）→ 未覆盖，原样保留。 */
  skippedEdited: string[];
  /** 库已移除 → 对应 skill 目录删除。 */
  removed: string[];
}

/** 读文件内容；不存在返回 undefined。 */
function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * 为每个例程库写一个 skill 目录（`<outDir>/<skill-name>/SKILL.md` +
 * `refs/<芯片>.md` 分表），并清理本工具生成但已无对应的陈旧文件。只认领带
 * 生成标记的文件——用户自建或手改过的绝不碰。
 */
export async function writeExampleSkills(
  libs: ExampleLibrary[],
  outDir: string,
  version: string,
): Promise<SkillsWriteResult> {
  const roots = libs.map((l) => l.root);
  const result: SkillsWriteResult = { written: [], kept: [], skippedEdited: [], removed: [] };
  fs.mkdirSync(outDir, { recursive: true });

  const wanted = new Set<string>();
  for (const lib of libs) {
    const dir = path.join(outDir, skillDirName(lib.root, roots));
    wanted.add(path.basename(dir));
    const file = path.join(dir, 'SKILL.md');
    const existing = readIfExists(file);
    if (existing !== undefined && !existing.includes(MARKER)) {
      result.skippedEdited.push(file);
      continue; // SKILL.md 被手改 → 整库跳过（分表也不动）
    }
    const changed = await writeIfChanged(file, renderExampleSkill(lib, version, roots));
    (changed ? result.written : result.kept).push(file);

    // 芯片分表：逐个写入（marker 语义同 SKILL.md），库内消失的芯片清掉分表
    const refsDir = path.join(dir, 'refs');
    fs.mkdirSync(refsDir, { recursive: true });
    const wantedRefs = new Set<string>();
    for (const [folder, list] of groupByChip(lib)) {
      const refFile = path.join(refsDir, `${chipRefSlug(folder)}.md`);
      wantedRefs.add(path.basename(refFile));
      const refExisting = readIfExists(refFile);
      if (refExisting !== undefined && !refExisting.includes(MARKER)) {
        continue; // 手改过的分表保留
      }
      await writeIfChanged(refFile, renderChipRef(folder, list));
    }
    for (const ent of fs.readdirSync(refsDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md') || wantedRefs.has(ent.name)) {
        continue;
      }
      const stale = path.join(refsDir, ent.name);
      if (readIfExists(stale)?.includes(MARKER)) {
        fs.rmSync(stale, { force: true });
      }
    }
  }

  for (const name of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!name.isDirectory() || !name.name.startsWith(PREFIX)) {
      continue;
    }
    const dir = path.join(outDir, name.name);
    if (wanted.has(name.name)) {
      continue;
    }
    const file = path.join(dir, 'SKILL.md');
    const owned = fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes(MARKER);
    if (owned) {
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(dir);
    }
  }

  return result;
}
