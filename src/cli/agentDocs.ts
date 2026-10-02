/**
 * agentDocs.ts — 在每个工程根生成 AGENTS.md + CLAUDE.md。
 *
 * 目的：让任何 AI 助手（Claude Code / Cursor / …）、CI 或裸终端在**没有
 * VS Code 扩展、没有本扩展 CLI** 的机器上也能完成构建/烧录 —— Makefile 工程
 * 本身自足，缺的只是"怎么找到 MRS2 工具链"的说明。路径只引用 <MRS2> 安装根
 * 的**相对布局**（各机器仅根目录不同），换电脑不失效。
 *
 * CLAUDE.md 仅一行 `@AGENTS.md`（Claude Code 的 import 语法），内容单一来源。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';
import { writeIfChanged } from '../util/fsx';

const MARKER = '<!-- mrs-toolbox:generated AGENTS.md -->';

/** 生成 AGENTS.md 文本。所有 <MRS2>/… 均为相对安装根的稳定布局。 */
export function renderAgentDocs(proj: MrsProject, inst: MrsInstallation, version: string): string {
  const fwd = (p: string) => p.split(path.sep).join('/');
  const relRoot = (p: string) => `<MRS2>/${fwd(path.relative(inst.root, p))}`;

  const tc = inst.toolchains.resolve(proj.mcu.toolchainName);
  const tcBin = tc ? relRoot(tc.binDir) : `<MRS2>/…/Toolchain/${proj.mcu.toolchainName}/bin`;
  const makeBin = relRoot(inst.makeBin);
  const ocdExe = relRoot(inst.openocdExe);
  const ocdScripts = relRoot(inst.openocdScripts);
  const ocdCfg = relRoot(path.join(inst.openocdRoot, 'bin', proj.mcu.toolchainType === 'ARM' ? 'wch-arm.cfg' : 'wch-riscv.cfg'));
  const target = proj.build.targetName;
  const hex = proj.flash.image ?? `obj/${target}.hex`;

  return `${MARKER}
# 工程构建指南（AI 助手 / CI / 命令行通用）

> 由 mrs-toolbox v${version} 生成。改了 \`.mrs-project.json\` 或源码布局后重跑
> \`mrs-toolbox gen\`（或 VS Code 扩展的 Generate Build Files）会刷新本文件与 Makefile。
> 本文件含手工修改时（首行无生成标记）**不会被覆盖**。

- MCU：\`${proj.mcu.mcuId}\`（${proj.mcu.series} · ${proj.mcu.toolchainType} / ${proj.mcu.toolchainName}）
- 构建系统：工程根的 \`Makefile\`（由 \`.mrs-project.json\` 生成，**勿手改 Makefile**）
- 产物：\`obj/${target}.{elf,hex,bin,lst,map}\`
- 前置条件：本机装有 MounRiver Studio 2。下文 \`<MRS2>\` = 其安装根目录
  （默认探测 \`C:/MounRiver/MounRiver_Studio2\` 一类路径；找不到就全盘搜 \`sub_manifest.json\`）。

## 方式一：mrs-toolbox CLI（自动探测 MRS2，推荐）

\`\`\`bash
npx mrs-toolbox build .            # 编译（默认 release；--config debug 切 -Og -g3）
npx mrs-toolbox rebuild .           # clean + build
npx mrs-toolbox flash .             # WCH-Link 烧录（先 build）
npx mrs-toolbox gen .               # 重新生成 Makefile / .cproject / IntelliSense / 本文件
npx mrs-toolbox doctor              # 检查 MRS2 / 工具链 / WCH-Link 环境
\`\`\`

## 方式二：裸 make（不装 mrs-toolbox，只要 MRS2）

Git Bash（Windows）/ Linux shell：

\`\`\`bash
export PATH="${makeBin}:${tcBin}:$PATH"
make -j8 CONFIG=release     # 或 CONFIG=debug；目标 all | clean | rebuild
\`\`\`

Windows cmd：

\`\`\`cmd
set PATH=${makeBin.replace(/\//g, '\\')};${tcBin.replace(/\//g, '\\')};%PATH%
make -j8 CONFIG=release
\`\`\`

## 烧录（WCH-Link，RV 模式）

\`\`\`bash
"${ocdExe}" -s "${ocdScripts}" -f "${ocdCfg}" \\
  -c "program \\"${hex}\\" verify reset" -c shutdown
\`\`\`

## 烧录方式二：ISP（USB/串口 Bootloader 直连，无需 WCH-Link）

需开源命令行工具 wchisp（https://github.com/ch32-rs/wchisp ，扩展不捆绑）。
Windows 上它依赖的 CH375DLL64.dll 与 ISP 驱动在 MRS2 的 WCHISPTool 目录
已自带，把 wchisp.exe 放同目录即可。先让芯片进入 BOOT 下载模式
（按住板上 BOOT 键再复位/上电；CH32V00x 无 USB ISP 且无 BOOT 引脚，
只能串口 + 程序内设 FLASH_STATR.MODE 软复位进入）：

\`\`\`bash
wchisp flash ${hex}                # USB 直连（CH58x/CH57x/CH55x 等）
wchisp -s -p COM5 flash ${hex}     # 串口（--port 换成实际 COM 号）
\`\`\`

（装有 mrs-toolbox 时等价于 \`mrs-toolbox isp . [--port COM5]\`。）

## 改配置的正确姿势

编辑 \`.mrs-project.json\`（唯一事实源），再 \`mrs-toolbox gen\` 重新生成。常用字段：

| 字段 | 含义 |
|---|---|
| \`mcu.toolchainName\` | GCC8 / GCC12 / ARM（改后重新 gen，Makefile 换前缀） |
| \`build.srcDirs\` / \`build.excludedPaths\` | 参与编译的目录 / 排除的文件 |
| \`build.defines\` / \`build.extraIncludes\` | 全局宏 / 额外头文件目录 |
| \`build.cFlagsExtra\` / \`build.ldFlagsExtra\` | 附加编译/链接选项（如 -flto） |
| \`build.debugOpt\` / \`build.releaseOpt\` | 两档配置的优化级别 |

## 附录：mrs-toolbox CLI 速查（AI 会话可用的全部操作）

全局 \`--mrs <MRS2根目录>\`（默认自动探测）；所有 \`[dir]\` 可省略 = 从 cwd 向上找
\`.mrs-project.json\`。VS Code 扩展的 QuickPick 类命令对 AI 不可用，下表 CLI 与
扩展同源同能力。

| 命令 | 作用 |
|---|---|
| \`mrs-toolbox doctor [dir]\` | 检查 MRS2 / 工具链 / 工程 / wchisp |
| \`mrs-toolbox build [dir] [-c debug\\|release] [-j N]\` | 编译（默认 release） |
| \`mrs-toolbox rebuild [dir]\` / \`clean [dir]\` | 重建 / 清理 |
| \`mrs-toolbox flash [dir]\` | WCH-Link 烧录（openocd） |
| \`mrs-toolbox isp [dir] [--port COMx] [--device N] [--tool <wchisp>]\` | ISP 直连烧录（USB/串口 Bootloader，无需 WCH-Link） |
| \`mrs-toolbox erase [dir]\` | 全片擦除 |
| \`mrs-toolbox gen [dir]\` | 重新生成 Makefile / .cproject / IntelliSense / 本文件 |
| \`mrs-toolbox create --mcu <ID> --dir <路径> [--from-example <例程>] [-D K=V]\` | 新建工程 |
| \`mrs-toolbox switch-mcu [dir] --mcu <ID>\` | 同系列切换型号（如 CH582F → CH582M） |
| \`mrs-toolbox mcus [--series <名>]\` | 列出可用系列与 MCU |
| \`mrs-toolbox skills [--lib <库>]… [--out <目录>]\` | 生成例程库 AI skills（每库一个 SKILL.md，默认 ~/.claude/skills；例程增删后重跑即同步） |
| \`mrs-toolbox ports\` | 列出 COM 口与适配器（WCH 优先） |
| \`mrs-toolbox serial [--port COMx] [-b 波特率] [--send 行]… [--duration 秒] [--eol crlf\\|lf]\` | 打开串口→发送→采集→关闭（与板上固件通信；唯一串口免 --port） |
| \`mrs-toolbox ble-scan [--duration 秒] [--name 过滤]\` | 扫描 BLE 广播设备（名/MAC/RSSI，需电脑蓝牙） |
| \`mrs-toolbox ble (--addr MAC\\|--name 广播名) [--list] [--send 行]… [--duration 秒] [--service U] [--char U]\` | BLE 连接调试：--list=GATT 服务/特征表；默认 UART 会话（自动识别 NUS/WCH/FFF0 透传服务，写→订阅通知→采集） |
`;
}

/** 写 AGENTS.md（含生成标记才覆盖）+ CLAUDE.md（@import 单行）。 */
export async function writeAgentDocs(projRoot: string, proj: MrsProject, inst: MrsInstallation): Promise<void> {
  const agents = path.join(projRoot, 'AGENTS.md');
  let existing: string | undefined;
  try {
    existing = await fs.promises.readFile(agents, 'utf-8');
  } catch {
    /* not there yet */
  }
  if (existing === undefined || existing.split(/\r?\n/, 1)[0].trim() === MARKER) {
    const version = require('../../package.json').version as string;
    await writeIfChanged(agents, renderAgentDocs(proj, inst, version));
  }
  await writeIfChanged(path.join(projRoot, 'CLAUDE.md'), '@AGENTS.md\n');
}
