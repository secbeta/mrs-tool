import * as vscode from 'vscode';
import type { ToolboxContext } from '../toolbox';
import { flashProject, eraseChip } from '../flash/flasher';
import { flashViaIsp, resolveIspTool, ispToolInstallHint, WCHISP_DOWNLOAD } from '../flash/ispFlasher';
import { listSerialPorts } from '../serial/serialPorts';
import { runBuild } from './build';

export async function runFlash(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  const target = req.proj.build.targetName;
  const started = Date.now();
  const out = await flashProject(req.inst, req.proj, req.root);
  const secs = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (out.ok) {
    void vscode.window.showInformationMessage(`烧录完成: ${target} · ${secs}`);
  } else if (out.hint) {
    void vscode.window.showWarningMessage(`烧录失败 — ${out.hint}`);
  } else {
    void vscode.window.showErrorMessage(`烧录失败: ${target} · ${secs} — 详情见输出面板 (MRS Toolbox Flash)。`);
  }
}

export async function runBuildAndFlash(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  if (!(await runBuild(tbx, 'build'))) {
    return;
  }
  await runFlash(tbx);
}

export async function runEraseChip(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `整片擦除 ${req.proj.mcu.mcuId}？此操作不可恢复。`,
    { modal: true },
    '擦除',
  );
  if (confirm !== '擦除') {
    return;
  }
  const target = req.proj.mcu.mcuId;
  const started = Date.now();
  const out = await eraseChip(req.inst, req.proj, req.root);
  const secs = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (out.ok) {
    void vscode.window.showInformationMessage(`整片擦除完成: ${target} · ${secs}`);
  } else if (out.hint) {
    void vscode.window.showWarningMessage(`擦除失败 — ${out.hint}`);
  } else {
    void vscode.window.showErrorMessage(`擦除失败: ${target} — 详情见输出面板 (MRS Toolbox Flash)。`);
  }
}

/** ISP 烧录：USB/串口 Bootloader 直连（wchisp），无需 WCH-Link。 */
export async function runIspFlash(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  const tool = await resolveIspTool(undefined, req.inst);
  if (!tool) {
    const pick = await vscode.window.showErrorMessage(
      '未找到 wchisp（ISP 直连烧录的命令行工具，扩展不捆绑）',
      '打开下载页',
      '查看安装说明',
    );
    if (pick === '打开下载页') {
      void vscode.env.openExternal(vscode.Uri.parse(WCHISP_DOWNLOAD));
    } else if (pick === '查看安装说明') {
      const ch = vscode.window.createOutputChannel('MRS Toolbox ISP Flash');
      ch.appendLine(ispToolInstallHint(req.inst));
      ch.show();
    }
    return;
  }

  type Transport = { label: string; description: string; serial: boolean };
  const transport = await vscode.window.showQuickPick<Transport>(
    [
      { label: '$(plug) USB', description: '默认 — 按住板上 BOOT 键复位进入 ISP 模式', serial: false },
      { label: '$(terminal) 串口', description: 'CH32V00x 等无 USB ISP 的芯片；下一步选 COM 口', serial: true },
    ],
    { placeHolder: `ISP 烧录方式（${req.proj.mcu.mcuId}）` },
  );
  if (!transport) {
    return;
  }
  let serialPort: string | undefined;
  if (transport.serial) {
    const ports = await listSerialPorts();
    if (!ports.length) {
      void vscode.window.showWarningMessage('未发现串口 — 插好板子后重试，或先用 Show Serial Ports 查看');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      ports.map((p) => ({
        label: p.isWch ? `$(check) ${p.port}` : p.port,
        description: p.name,
        port: p.port,
      })),
      { placeHolder: '选择串口（WCH 适配器排最前）' },
    );
    if (!picked) {
      return;
    }
    serialPort = picked.port;
  }

  const target = req.proj.build.targetName;
  const started = Date.now();
  const out = await flashViaIsp(req.inst, req.proj, req.root, { serialPort, toolPath: tool });
  const secs = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (out.ok) {
    void vscode.window.showInformationMessage(`ISP 烧录完成: ${target} · ${secs}`);
  } else if (out.hint) {
    void vscode.window.showWarningMessage(`ISP 烧录失败 — ${out.hint}`);
  } else {
    void vscode.window.showErrorMessage(`ISP 烧录失败: ${target} · ${secs} — 详情见输出面板 (MRS Toolbox ISP Flash)。`);
  }
}

export function registerFlashCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mrsToolbox.flash', () => runFlash(tbx)),
    vscode.commands.registerCommand('mrsToolbox.buildAndFlash', () => runBuildAndFlash(tbx)),
    vscode.commands.registerCommand('mrsToolbox.eraseChip', () => runEraseChip(tbx)),
    vscode.commands.registerCommand('mrsToolbox.ispFlash', () => runIspFlash(tbx)),
  ];
}
