import * as vscode from 'vscode';
import * as path from 'path';
import { runProcess } from '../util/proc';
import { flashImageAbs } from '../gen/makefileGen';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';
import { pathExists } from '../util/fsx';

let output: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('MRS Toolbox Flash');
  }
  return output;
}

function openocdArgs(inst: MrsInstallation, proj: MrsProject, commands: string[]): string[] {
  const cfg = path.join(inst.openocdRoot, 'bin', proj.mcu.toolchainType === 'ARM' ? 'wch-arm.cfg' : 'wch-riscv.cfg');
  const args = ['-s', inst.openocdScripts, '-f', cfg];
  // Custom ports (vscode settings) are applied before any -c command so they
  // take effect while the config files load.
  const settings = vscode.workspace.getConfiguration('mrsToolbox');
  const gdbPort = settings.get<number>('openocd.gdbPort', 3333);
  const telnetPort = settings.get<number>('openocd.telnetPort', 4444);
  const tclPort = settings.get<number>('openocd.tclPort', 6666);
  if (gdbPort !== 3333) {
    args.push('-c', `gdb_port ${gdbPort}`);
  }
  if (telnetPort !== 4444) {
    args.push('-c', `telnet_port ${telnetPort}`);
  }
  if (tclPort !== 6666) {
    args.push('-c', `tcl_port ${tclPort}`);
  }
  for (const c of commands) {
    args.push('-c', c);
  }
  args.push('-c', 'shutdown');
  return args;
}

export interface FlashOutcome {
  ok: boolean;
  /** Actionable hint when the failure looks like a driver/link problem. */
  hint?: string;
}

/** Flash the project's hex via the MRS2 OpenOCD; output streamed to a channel. */
export async function flashProject(
  inst: MrsInstallation,
  proj: MrsProject,
  projRoot: string,
): Promise<FlashOutcome> {
  const image = flashImageAbs(projRoot, proj);
  if (!(await pathExists(image))) {
    return { ok: false, hint: `image not found: ${image} — build the project first` };
  }

  const ch = channel();
  ch.clear();
  ch.show(true);
  ch.appendLine(`> ${inst.openocdExe} program ${image}`);

  const cfg = vscode.workspace.getConfiguration('mrsToolbox');
  const verify = cfg.get<boolean>('flash.verify', true) && proj.flash.verify;
  const programCmd = `program "${image}"${verify ? ' verify' : ''}${proj.flash.resetRun ? ' reset' : ''}`;

  const cmds = [programCmd];
  if (proj.flash.eraseMode === 'sectors-only') {
    cmds.unshift('init', 'halt', 'flash erase_sector 0 0 last');
  }

  const result = await runProcess(inst.openocdExe, openocdArgs(inst, proj, cmds), {
    cwd: projRoot,
    onLine: (line) => ch.appendLine(line),
  });

  const text = result.output;
  if (result.code === 0 && !/error|failed/i.test(text)) {
    ch.appendLine('== Flash OK ==');
    return { ok: true };
  }

  const hint = detectHint(text);
  ch.appendLine(`== Flash FAILED (exit ${result.code}) ==`);
  if (hint) {
    ch.appendLine(`提示: ${hint}`);
  }
  return { ok: false, hint };
}

/** Best-effort full chip erase. */
export async function eraseChip(inst: MrsInstallation, proj: MrsProject, projRoot: string): Promise<FlashOutcome> {
  const ch = channel();
  ch.clear();
  ch.show(true);
  const isArm = proj.mcu.toolchainType === 'ARM';
  const cmds = isArm
    ? ['init', 'halt', 'stm32f1x mass_erase 0']
    : ['init', 'halt', 'flash erase_sector wch_riscv 0 last'];
  const result = await runProcess(inst.openocdExe, openocdArgs(inst, proj, cmds), {
    cwd: projRoot,
    onLine: (line) => ch.appendLine(line),
  });
  const ok = result.code === 0 && !/error|failed/i.test(result.output);
  ch.appendLine(ok ? '== Erase OK ==' : `== Erase FAILED (exit ${result.code}) ==`);
  return { ok, hint: ok ? undefined : detectHint(result.output) };
}

function detectHint(text: string): string | undefined {
  if (/libusb|usb_open|no such device|cannot open/i.test(text)) {
    return '未检测到 WCH-Link：检查 USB 连接与驱动（可用命令 "MRS Toolbox: Open WCH-LinkUtility" 安装驱动）；ARM 芯片需 WCH-LinkE 处于 DAP 模式';
  }
  if (/wlinke|wch-link/i.test(text) && /fail|error/i.test(text)) {
    return 'WCH-Link 通信失败：尝试重新插拔、更新固件，或用 WCH-LinkUtility 检查模式（RV/DAP）';
  }
  return undefined;
}
