import * as vscode from 'vscode';
import type { ToolboxContext } from '../toolbox';
import { runOpenComTransmit } from './misc';
import {
  invalidateSerialPorts,
  listSerialPorts,
  type SerialPortInfo,
} from '../serial/serialPorts';

/**
 * Serial port visibility: which COM port is the board on? A QuickPick over
 * the enumerated ports (WCH adapters first) plus a sidebar section that
 * lists them. Picking/clicking a port copies its name and offers to open
 * MRS2's serial terminal (COMTransmit's own config is binary, so it still
 * picks the port itself).
 */
export async function runShowSerialPorts(tbx: ToolboxContext): Promise<void> {
  const ports = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'MRS Toolbox: 正在枚举串口…' },
    () => listSerialPorts(),
  );
  if (ports.length === 0) {
    const act = await vscode.window.showInformationMessage(
      '未检测到串口设备。插上开发板或 WCH-Link 后重试；仍看不到时通常是缺串口驱动（CH343/CH340）。',
      '重试',
      '安装驱动…',
    );
    if (act === '重试') {
      invalidateSerialPorts();
      return runShowSerialPorts(tbx);
    }
    if (act === '安装驱动…') {
      void vscode.commands.executeCommand('mrsToolbox.installLinkDriver');
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    ports.map((p) => ({
      label: p.port,
      description: p.isWch ? `WCH · ${describe(p)}` : describe(p),
      detail: p.pnpId,
      port: p,
    })),
    { placeHolder: '选择串口（WCH 适配器排在最前）；选择后复制端口名' },
  );
  if (picked) {
    await offerPort(tbx, picked.port);
  }
}

/** Tree click: arg = SerialPortInfo; palette invocation falls back to the pick. */
export async function runCopySerialPort(
  tbx: ToolboxContext,
  arg?: SerialPortInfo,
): Promise<void> {
  if (arg) {
    await offerPort(tbx, arg);
  } else {
    await runShowSerialPorts(tbx);
  }
}

/** Re-enumerate and rebuild the tree section. */
export async function runRefreshSerialPorts(tbx: ToolboxContext): Promise<void> {
  invalidateSerialPorts();
  await listSerialPorts();
  tbx.refresh();
}

function describe(p: SerialPortInfo): string {
  return p.name.replace(/\s*\(COM\d+\)\s*$/, '') || p.name;
}

async function offerPort(tbx: ToolboxContext, port: SerialPortInfo): Promise<void> {
  await vscode.env.clipboard.writeText(port.port);
  const act = await vscode.window.showInformationMessage(
    `已复制 ${port.port}（${describe(port)}）`,
    '打开串口工具',
  );
  if (act === '打开串口工具') {
    await runOpenComTransmit(tbx);
  }
}

export function registerSerialCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mrsToolbox.showSerialPorts', () => runShowSerialPorts(tbx)),
    vscode.commands.registerCommand('mrsToolbox.copySerialPort', (arg) =>
      runCopySerialPort(tbx, arg as SerialPortInfo | undefined),
    ),
    vscode.commands.registerCommand('mrsToolbox.refreshSerialPorts', () =>
      runRefreshSerialPorts(tbx),
    ),
  ];
}
