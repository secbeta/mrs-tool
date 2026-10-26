import * as vscode from 'vscode';
import * as path from 'path';
import { IS_WINDOWS } from '../constants';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { ToolboxContext } from '../toolbox';
import { pathExists } from '../util/fsx';
import { runProcess } from '../util/proc';
import { runBleScan } from '../ble/bleConsole';

/** Open the project root as an Eclipse folder import in MRS2 (best effort). */
export async function runOpenInMounRiver(tbx: ToolboxContext): Promise<void> {
  const req = await tbx.require();
  if (!req) {
    return;
  }
  const exe = req.inst.mrsExe;
  if (!(await pathExists(exe))) {
    void vscode.window.showErrorMessage(`未找到 MRS2 主程序: ${exe}`);
    return;
  }
  // MRS2 (VSCode fork) accepts a folder argument; .wvproj is not generated.
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '启动 MounRiver Studio…' },
    () =>
      new Promise<void>((resolve) => {
        // Detached spawn; the IDE opens on its own.
        const child = require('child_process').spawn(exe, [req.root], {
          detached: true,
          stdio: 'ignore',
          shell: false,
        });
        child.on('spawn', () => resolve());
        child.on('error', (err: Error) => {
          // Linux 解压包常见：主程序没有可执行位（tar 保留与否取决于来源）。
          const hint = /EACCES|permission|denied/i.test(err.message)
            ? `（无执行权限，先运行 chmod +x "${exe}"）`
            : '';
          void vscode.window.showErrorMessage(`启动 MRS2 失败: ${err.message}${hint}`);
          resolve();
        });
        setTimeout(resolve, 3000);
      }),
  );
}

export async function runOpenWchLinkUtility(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  await launchTool(inst.wchLinkUtilityExe, 'WCH-LinkUtility');
  // The tool itself asks "debug interface is enable … go on?" whenever a
  // target chip is attached — expected behavior, not a launch failure.
  // Explain it once so the dialog doesn't read as an error.
  const HINT = 'wchLinkUtilityHintShown';
  if (!tbx.ext.workspaceState.get<boolean>(HINT)) {
    void tbx.ext.workspaceState.update(HINT, true);
    void vscode.window.showInformationMessage(
      'WCH-LinkUtility 连上目标芯片后会弹安全提示「调试接口已开启、代码可被读出，是否继续」——' +
        '开发阶段选「是」即可；量产烧录请在工具内关闭调试接口并开启代码保护。',
      '知道了',
    );
  }
}

/** Launch one of the GUI utilities bundled with MRS2, detached. */
async function launchTool(exe: string, label: string): Promise<void> {
  if (!(await pathExists(exe))) {
    void vscode.window.showErrorMessage(
      IS_WINDOWS
        ? `未找到 ${label}: ${exe}`
        : `${label} 是 Windows 版 MRS2 自带的 GUI 工具，Linux 安装包不包含；` +
            `命令行等价能力仍可用（烧录用 Flash / Flash via ISP，串口用串口终端 Serial Monitor）。`,
    );
    return;
  }
  const child = require('child_process').spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.on('error', (err: Error) => {
    void vscode.window.showErrorMessage(`启动 ${label} 失败: ${err.message}`);
  });
  child.unref();
}

/** 串口工具 COMTransmit（MRS2 自带串口助手）. */
export async function runOpenComTransmit(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  await launchTool(inst.comTransmitExe, '串口工具 COMTransmit');
}

/** HEX/BIN 合并转换工具 HexBinStudio. */
export async function runOpenHexBinStudio(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  await launchTool(inst.hexBinStudioExe, 'HexBinStudio');
}

/** Keil → MRS 工程转换器. */
export async function runOpenKeilConvert(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  await launchTool(inst.keilConvertExe, 'Keil 工程转换器');
}

/**
 * WCH 单片机编程工具（ISP 工作室）。带 USB Bootloader 的芯片
 * （CH55x/CH57x/CH58x 等）用普通 USB 线直连即可烧录，无需 WCH-Link。
 */
export async function runOpenIspTool(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  await launchTool(inst.ispToolStudioExe, 'WCH ISP 编程工具 (WchIspStudio)');
  const HINT = 'ispToolHintShown';
  if (!tbx.ext.workspaceState.get<boolean>(HINT)) {
    void tbx.ext.workspaceState.update(HINT, true);
    void vscode.window.showInformationMessage(
      'ISP 烧录不走 WCH-Link：板子用 USB 线直连电脑，按住 BOOT（下载）键的同时复位/上电进入 ISP 模式，' +
        '工具即可识别芯片并下载（CH58x 等）。首次识别不到通常是没进 ISP 模式或缺 USB 驱动。',
      '知道了',
    );
  }
}

/** WCH 触摸按键校准工具. */
export async function runOpenTouchKeyTool(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  await launchTool(inst.touchKeyToolExe, 'WCH 触摸按键校准工具');
}

/** Windows 设备管理器（查串口号 / 驱动状态）. */
export function runOpenDeviceManager(): void {
  if (!IS_WINDOWS) {
    void vscode.window.showInformationMessage(
      '设备管理器是 Windows 工具。Linux 查看串口/USB 设备：终端运行 `lsusb`、`dmesg | tail`（插拔对比），串口列表用「Show Serial Ports」。',
    );
    return;
  }
  const child = require('child_process').spawn('cmd.exe', ['/c', 'start', '', 'devmgmt.msc'], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.on('error', (err: Error) => {
    void vscode.window.showErrorMessage(`打开设备管理器失败: ${err.message}`);
  });
  child.unref();
}

const SERIAL_MONITOR_IDS = [
  'ms-vscode.vscode-serial-monitor',
  'eclipse-cdt-cloud.vscode-serial-monitor',
];
const SERIAL_MONITOR_COMMANDS = [
  'vscode-serial-monitor.openSerialMonitor',
  'vscode-serial-monitor.focusSerialMonitorView',
];

/**
 * 串口终端：MRS2 的「串口终端」是 IDE 内置面板，外部无法复用；VS Code 对应
 * 体验是微软 Serial Monitor 扩展（终端面板里的一个标签）。已安装则直接呼出，
 * 未安装则给安装入口，并提供 COMTransmit 兜底。
 */
export async function runOpenSerialTerminal(tbx: ToolboxContext): Promise<void> {
  const ext = SERIAL_MONITOR_IDS.map((id) => vscode.extensions.getExtension(id)).find((e) => !!e);
  if (!ext) {
    const pick = await vscode.window.showInformationMessage(
      '串口终端由 VS Code「Serial Monitor」扩展提供（微软官方）：装好后打开终端面板，' +
        '在下拉里选 Serial Monitor 即可收发串口数据。',
      '安装 Serial Monitor',
      '改用串口工具 COMTransmit',
    );
    if (pick === '安装 Serial Monitor') {
      void vscode.env.openExternal(
        vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-serial-monitor'),
      );
    } else if (pick === '改用串口工具 COMTransmit') {
      await runOpenComTransmit(tbx);
    }
    return;
  }
  await ext.activate();
  for (const cmd of SERIAL_MONITOR_COMMANDS) {
    try {
      await vscode.commands.executeCommand(cmd);
      return;
    } catch {
      /* try the next candidate */
    }
  }
  void vscode.window.showInformationMessage(
    'Serial Monitor 已就绪：打开终端面板（Ctrl+`），在标签下拉里选择「Serial Monitor」。',
  );
}

/** 扫描 BLE 广播设备并 QuickPick 展示（选中复制 MAC）。 */
export async function runScanBleDevices(): Promise<void> {
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '扫描 BLE 设备（6 秒）…' },
    () => runBleScan({ durationSec: 6 }),
  );
  if (!r.ok) {
    void vscode.window.showErrorMessage(`BLE 扫描失败: ${r.hint ?? '见输出'}`);
    return;
  }
  const devs = r.data ?? [];
  if (!devs.length) {
    void vscode.window.showInformationMessage('未发现 BLE 广播设备（确认板子在广播、电脑蓝牙已开）');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    devs.map((d) => ({
      label: d.name,
      description: d.mac,
      detail: `${d.rssi} dBm${d.connectable ? ' · 可连接' : ''}`,
    })),
    { placeHolder: `扫描到 ${devs.length} 台 BLE 设备（选中复制 MAC 地址）` },
  );
  if (pick) {
    await vscode.env.clipboard.writeText(pick.description ?? '');
    void vscode.window.showInformationMessage(`已复制 ${pick.label} 的地址: ${pick.description}`);
  }
}

const BLEDEBUG_DOWNLOAD = 'https://www.wch.cn/downloads/BLEDebug_ZIP.html';

/** WCH 官方 BLE 调试助手（独立下载的 GUI 工具，MRS2 不自带）。 */
export async function runOpenBleDebug(): Promise<void> {
  if (!IS_WINDOWS) {
    void vscode.window.showInformationMessage(
      'WCH BLEDebug 是 Windows GUI 工具（自解压 EXE 发行），Linux 无法运行；BLE 调试可用系统 bluetoothctl 等工具。',
    );
    return;
  }
  let exe = vscode.workspace.getConfiguration('mrsToolbox').get<string>('bleDebugPath', '');
  if (!exe) {
    const r = await runProcess('where.exe', ['BLEDebug.exe'], { timeoutMs: 5000 });
    exe = r.code === 0 ? r.output.split(/\r?\n/)[0].trim() : '';
  }
  if (!exe || !(await pathExists(exe))) {
    const pick = await vscode.window.showInformationMessage(
      '未找到 WCH 蓝牙调试助手（BLEDebug）——MRS2 不自带，需从沁恒官网下载解压（发行包是自解压 EXE）。',
      '打开下载页',
      '在设置中指定路径',
    );
    if (pick === '打开下载页') {
      void vscode.env.openExternal(vscode.Uri.parse(BLEDEBUG_DOWNLOAD));
    } else if (pick === '在设置中指定路径') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'mrsToolbox.bleDebugPath');
    }
    return;
  }
  const child = require('child_process').spawn(exe, [], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', (err: Error) => {
    void vscode.window.showErrorMessage(`启动 BLE 调试助手失败: ${err.message}`);
  });
  child.unref();
}

/** Pick one of the bundled LinkDrv setups and run its SETUP.EXE (UAC elevates). */
export async function runInstallLinkDriver(tbx: ToolboxContext): Promise<void> {
  const inst = await tbx.ensureInstallation();
  if (!inst) {
    return;
  }
  if (!IS_WINDOWS) {
    await showUdevHelp(inst);
    return;
  }
  const available = inst.linkDriverSetups.filter((d) => {
    try {
      return require('fs').existsSync(d.exe);
    } catch {
      return false;
    }
  });
  if (available.length === 0) {
    void vscode.window.showErrorMessage(`未找到驱动安装包: ${path.dirname(inst.linkDriverSetups[0].exe)}`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    available.map((d) => ({ label: d.label, description: d.exe, id: d.id })),
    { placeHolder: '选择要安装的驱动（需要管理员权限）' },
  );
  if (!pick) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `即将运行 ${pick.label} 的安装程序，Windows 会弹出 UAC 授权。继续？`,
    { modal: true },
    '安装',
  );
  if (confirm !== '安装') {
    return;
  }
  const child = require('child_process').spawn(pick.description, [], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.on('error', (err: Error) => {
    void vscode.window.showErrorMessage(`启动安装程序失败: ${err.message}`);
  });
  child.unref();
}

/**
 * Linux 的"装驱动"等价物：安装 MRS2 自带的 udev 规则（WCH-Link / 串口
 * 免 root 可用）。写 /etc 需要管理员权限，扩展不静默提权 —— 把现成的
 * 安装命令给用户复制到终端执行。
 */
async function showUdevHelp(inst: MrsInstallation): Promise<void> {
  const rules = inst.udevRuleFiles;
  const RULES_DIR = '/etc/udev/rules.d';
  if (rules.length === 0) {
    void vscode.window.showInformationMessage(
      `Linux 不需要安装 Windows 驱动：WCH-Link / 串口的可用性由 udev 规则保证。` +
        `未在 ${inst.root} 下找到 *.rules 文件（expected beforeinstall/），请从 MRS2 安装包的 beforeinstall 目录获取。`,
    );
    return;
  }
  const cmd =
    `sudo cp ${rules.map((r) => `"${r}"`).join(' ')} ${RULES_DIR}/ && ` +
    'sudo udevadm control --reload-rules && sudo udevadm trigger';
  const pick = await vscode.window.showInformationMessage(
    'Linux 不需要 Windows 驱动：把 MRS2 自带的 udev 规则装入系统后，WCH-Link / 串口即免 root、免驱动可用。已找到规则文件：\n' +
      rules.join('\n'),
    '复制安装命令',
  );
  if (pick === '复制安装命令') {
    await vscode.env.clipboard.writeText(cmd);
    void vscode.window.showInformationMessage(
      `已复制安装命令，粘贴到终端执行（需要 sudo，完成前请勿拔插设备）：\n${cmd}`,
    );
  }
}

/** Tree helper: describe the active project for tooltips. */
export function projectLabel(tbx: ToolboxContext): string {
  return path.basename(tbx.installation?.root ?? '');
}

export function registerMiscCommands(tbx: ToolboxContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('mrsToolbox.openInMounRiver', () => runOpenInMounRiver(tbx)),
    vscode.commands.registerCommand('mrsToolbox.openWchLinkUtility', () => runOpenWchLinkUtility(tbx)),
    vscode.commands.registerCommand('mrsToolbox.openComTransmit', () => runOpenComTransmit(tbx)),
    vscode.commands.registerCommand('mrsToolbox.openHexBinStudio', () => runOpenHexBinStudio(tbx)),
    vscode.commands.registerCommand('mrsToolbox.openKeilConvert', () => runOpenKeilConvert(tbx)),
    vscode.commands.registerCommand('mrsToolbox.openIspTool', () => runOpenIspTool(tbx)),
    vscode.commands.registerCommand('mrsToolbox.openTouchKeyTool', () => runOpenTouchKeyTool(tbx)),
    vscode.commands.registerCommand('mrsToolbox.openDeviceManager', () => runOpenDeviceManager()),
    vscode.commands.registerCommand('mrsToolbox.openSerialTerminal', () => runOpenSerialTerminal(tbx)),
    vscode.commands.registerCommand('mrsToolbox.scanBleDevices', () => runScanBleDevices()),
    vscode.commands.registerCommand('mrsToolbox.openBleDebug', () => runOpenBleDebug()),
    vscode.commands.registerCommand('mrsToolbox.installLinkDriver', () => runInstallLinkDriver(tbx)),
  ];
}
