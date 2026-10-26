/**
 * ispFlasher.ts — ISP 烧录（USB/串口 Bootloader 直连，**无需 WCH-Link**）。
 *
 * 扩展不捆绑任何二进制：调用开源命令行工具 wchisp（ch32-rs，Rust）。
 * 选它而不是官方 WCHISPTool_CMD 的原因：官方版每次运行都必须传
 * `-c Config.ini`，而该 ini 只能用 GUI 版 WchIspStudio 的「Save UI Config」
 * 生成 —— 纯命令行 / AI 场景绕不开 GUI。wchisp 零配置：
 *   wchisp flash <hex>                USB ISP（默认）
 *   wchisp -s -p COM5 flash <hex>     串口 ISP（CH32V00x 无 USB ISP，只能串口）
 * Windows 上 wchisp 依赖 VC 运行库 + CH375DLL64.dll —— 后者及 ISP 驱动
 * MRS2 的 WCHISPTool 目录已自带（见 inst.ispToolStudioExe 所在目录），
 * 把 wchisp.exe 放同目录即可复用，无需再装任何东西。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { runProcess } from '../util/proc';
import { flashImageAbs } from '../gen/makefileGen';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';
import type { FlashOutcome } from './flasher';
import { pathExists } from '../util/fsx';

export const WCHISP_DOWNLOAD = 'https://github.com/ch32-rs/wchisp/releases/tag/nightly';

/** Windows 加载器缺失 DLL（CH375DLL64.dll）时的退出码：0xC0000135。 */
const STATUS_DLL_NOT_FOUND = 3221225781;

let output: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('MRS Toolbox ISP Flash');
  }
  return output;
}

export interface IspFlashOptions {
  /** 串口 ISP（CH32V00x 无 USB ISP，只能串口）。 */
  serialPort?: string;
  /** 多块板子时的设备序号（wchisp -d）。 */
  deviceIndex?: number;
  /** 直接指定 wchisp 路径（CLI --tool）。 */
  toolPath?: string;
}

/** 生成 wchisp 命令行（纯函数，单测覆盖）。全局项在子命令之前。 */
export function ispFlashArgs(image: string, opts: IspFlashOptions = {}): string[] {
  const args: string[] = [];
  if (opts.deviceIndex !== undefined) {
    args.push('-d', String(opts.deviceIndex));
  }
  if (opts.serialPort) {
    args.push('--serial', '--port', opts.serialPort);
  }
  args.push('flash', image);
  return args;
}

/** 安装指引：wchisp 不随扩展分发；Windows 下 MRS2 目录里已有其 DLL 依赖与驱动。 */
export function ispToolInstallHint(inst?: MrsInstallation): string {
  const isWin = process.platform === 'win32';
  const lines = [
    '未找到 wchisp —— USB/串口 Bootloader 直连烧录（ISP）的命令行工具，扩展不捆绑二进制。',
    isWin
      ? `下载 Windows 版: ${WCHISP_DOWNLOAD}（需 VC 运行库，页面有链接）`
      : `安装: cargo install wchisp，或从 ${WCHISP_DOWNLOAD} 下载 Linux 版（注意 chmod +x）`,
  ];
  if (inst) {
    if (isWin) {
      lines.push(
        `MRS2 的 ISP 目录已自带 CH375DLL64.dll 与驱动: ${path.dirname(inst.ispToolStudioExe)}`,
        '把 wchisp.exe 放进该目录即可复用（无需再装驱动）；或用设置 mrsToolbox.ispToolPath / CLI --tool 指定其位置',
      );
    } else {
      lines.push(
        'Linux 无需任何 DLL/驱动：wchisp 经 USB（libusb）或串口直连；无权限时先装 udev 规则或加 dialout 组',
      );
    }
  } else {
    lines.push('放到 PATH 可见的位置，或用设置 mrsToolbox.ispToolPath / CLI --tool 指定其位置');
  }
  return lines.join('\n');
}

/**
 * 找 wchisp：显式路径 → 设置 mrsToolbox.ispToolPath → **MRS2 的 WCHISPTool
 * 目录**（安装指引让用户放的位置，旁边就是它需要的 CH375DLL64.dll 与驱动）
 * → PATH（where/which）。找不到返回 undefined（调用方给安装指引）。
 */
export async function resolveIspTool(explicit?: string, inst?: MrsInstallation): Promise<string | undefined> {
  const mrsDirTool = inst ? path.join(path.dirname(inst.ispToolStudioExe), process.platform === 'win32' ? 'wchisp.exe' : 'wchisp') : undefined;
  const candidates = [
    explicit,
    vscode.workspace.getConfiguration('mrsToolbox').get<string>('ispToolPath', ''),
    mrsDirTool,
  ].filter((p): p is string => !!p && p.trim().length > 0);
  for (const p of candidates) {
    if (await pathExists(p)) {
      return p;
    }
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const probe = process.platform === 'win32' ? 'wchisp.exe' : 'wchisp';
  const r = await runProcess(finder, [probe], { timeoutMs: 5000 });
  if (r.code === 0) {
    const first = r.output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (first && (await pathExists(first))) {
      return first;
    }
  }
  return undefined;
}

/** 把失败输出归类成可操作的中文提示（纯函数，单测覆盖）。 */
export function detectIspHint(text: string, code: number | null): string | undefined {
  if (/CH375DLL64/i.test(text) || code === STATUS_DLL_NOT_FOUND) {
    return 'wchisp 缺少 CH375DLL64.dll：从 MRS2 的 WCHISPTool 目录复制一份放到 wchisp.exe 旁边（该目录本就自带）';
  }
  if (/no usb device|matches.*vid|device not found|NoChip|chip not|未检测到|没有找到|timed? ?out|timeout/i.test(text)) {
    return '未发现 ISP 设备：让芯片进入 BOOT 下载模式（按住板上 BOOT 键再复位/上电）后重试；串口模式另需选对 COM 口';
  }
  if (/failed to open|serial|com\d+|串口/i.test(text) && /fail|error|拒绝|占用/i.test(text)) {
    return '串口打开失败：检查 COM 号是否正确、是否被串口终端 / COMTransmit 占用';
  }
  return undefined;
}

/** 用 wchisp 烧录工程 hex（USB 或串口 ISP）；输出流式进入 ISP 通道。 */
export async function flashViaIsp(
  inst: MrsInstallation,
  proj: MrsProject,
  projRoot: string,
  opts: IspFlashOptions = {},
): Promise<FlashOutcome> {
  const image = flashImageAbs(projRoot, proj);
  if (!(await pathExists(image))) {
    return { ok: false, hint: `image not found: ${image} — build the project first` };
  }
  const tool = opts.toolPath ?? (await resolveIspTool(undefined, inst));
  if (!tool) {
    return { ok: false, hint: ispToolInstallHint(inst) };
  }

  const args = ispFlashArgs(image, opts);
  const ch = channel();
  ch.clear();
  ch.show(true);
  ch.appendLine(`> ${tool} ${args.join(' ')}`);

  const result = await runProcess(tool, args, {
    cwd: projRoot,
    onLine: (line) => ch.appendLine(line),
  });

  if (result.code === 0) {
    ch.appendLine('== ISP Flash OK ==');
    return { ok: true };
  }
  const hint = detectIspHint(result.output, result.code);
  ch.appendLine(`== ISP Flash FAILED (exit ${result.code}) ==`);
  if (hint) {
    ch.appendLine(`提示: ${hint}`);
  }
  return { ok: false, hint };
}
