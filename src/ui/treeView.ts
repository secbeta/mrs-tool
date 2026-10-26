import * as vscode from 'vscode';
import { IS_WINDOWS } from '../constants';
import type { ToolboxContext } from '../toolbox';
import { listSerialPorts } from '../serial/serialPorts';

type NodeKind = 'section' | 'setup' | 'project' | 'info' | 'action' | 'tool' | 'create' | 'port';

interface Row {
  kind: NodeKind;
  label: string;
  description?: string;
  icon?: string;
  command?: string;
  /** Argument passed through TreeItem.command (e.g. the port to copy). */
  commandArg?: unknown;
  children?: Row[];
  /** Children computed on first expand (serial ports: enumeration is not free). */
  loadChildren?: () => Promise<Row[]>;
  /** Sections expand by default; set true to start collapsed. */
  collapsed?: boolean;
}

/**
 * Main sidebar, grouped into collapsible sections (ESP-IDF-extension style):
 * 环境 (install/config) · 工程 (active project) · 操作 (build/flash/debug) ·
 * 新建 (create/import, always available) · 工具 · 串口 (COM ports, lazy).
 * When MRS2 is not configured
 * the tree collapses to setup rows next to the welcome page.
 */
export class ToolboxTree implements vscode.TreeDataProvider<Row> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly tbx: ToolboxContext) {
    tbx.onDidChange(() => this._onDidChange.fire());
  }

  getTreeItem(el: Row): vscode.TreeItem {
    const isSection = !!el.children || !!el.loadChildren;
    const item = new vscode.TreeItem(
      el.label,
      isSection
        ? el.collapsed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = el.description;
    if (el.icon) {
      item.iconPath = new vscode.ThemeIcon(el.icon);
    }
    item.contextValue = el.kind;
    if (el.command) {
      item.command = { command: el.command, title: el.label, arguments: [el.commandArg] };
    }
    return item;
  }

  async getChildren(el?: Row): Promise<Row[]> {
    if (el) {
      if (el.children) {
        return el.children;
      }
      return el.loadChildren ? el.loadChildren() : [];
    }
    return this.buildRows();
  }

  private async buildRows(): Promise<Row[]> {
    const inst = this.tbx.installation;

    if (!inst) {
      return [
        { kind: 'setup', label: 'MounRiver Studio 2 未配置', icon: 'error', command: 'mrsToolbox.setup' },
        { kind: 'setup', label: '运行 Setup 自动探测…', icon: 'zap', command: 'mrsToolbox.setup' },
        { kind: 'setup', label: '打开配置页面…', icon: 'settings-gear', command: 'mrsToolbox.configure' },
      ];
    }

    const rows: Row[] = [
      {
        kind: 'section',
        label: '环境',
        icon: 'circuit-board',
        children: [
          { kind: 'info', label: 'MounRiver Studio 2', description: inst.root, icon: 'circuit-board', command: 'mrsToolbox.setup' },
          { kind: 'info', label: '配置页面', description: '安装/例程库/烧录调试选项', icon: 'settings-gear', command: 'mrsToolbox.configure' },
        ],
      },
      {
        kind: 'section',
        label: '新建工程',
        icon: 'add',
        children: [
          { kind: 'create', label: '从模板新建…', icon: 'new-folder', command: 'mrsToolbox.createNewProject' },
          { kind: 'create', label: '从例程创建…', icon: 'play', command: 'mrsToolbox.createProjectFromExample' },
          { kind: 'create', label: '导入已有源码…', icon: 'folder-opened', command: 'mrsToolbox.importProject' },
        ],
      },
    ];

    const active = await this.tbx.activeProject();
    if (active) {
      const { proj } = active;
      rows.splice(1, 0, {
        kind: 'section',
        label: '工程',
        icon: 'chip',
        children: [
          {
            kind: 'project',
            label: proj.build.targetName,
            description: `${proj.mcu.toolchainType} · ${proj.mcu.series} · ${this.tbx.buildConfig}`,
            icon: 'chip',
            command: 'mrsToolbox.selectProject',
          },
          {
            kind: 'action',
            label: `切换配置 (${this.tbx.buildConfig})`,
            description: 'debug ↔ release',
            icon: 'settings-gear',
            command: 'mrsToolbox.setBuildConfiguration',
          },
        ],
      });
      rows.splice(2, 0, {
        kind: 'section',
        label: '操作',
        icon: 'play-circle',
        children: [
          { kind: 'action', label: '编译 (F7)', icon: 'gear', command: 'mrsToolbox.build' },
          { kind: 'action', label: '烧录 (F8)', icon: 'zap', command: 'mrsToolbox.flash' },
          { kind: 'action', label: '调试 (F5)', icon: 'debug-alt', command: 'mrsToolbox.debug' },
          { kind: 'action', label: '重新生成构建文件', icon: 'refresh', command: 'mrsToolbox.generateBuildFiles' },
        ],
      });
    }

    rows.push({
      kind: 'section',
      label: '工具',
      icon: 'tools',
      children: [
        { kind: 'tool', label: '在 MRS2 中打开', icon: 'link-external', command: 'mrsToolbox.openInMounRiver' },
        // 以下 GUI 工具仅随 Windows 版 MRS2 发行，Linux 上隐藏（命令仍可
        // 手动触发，misc.ts 会给出说明而非报错）。
        ...(IS_WINDOWS
          ? ([
              { kind: 'tool', label: 'WCH-LinkUtility', description: 'WCH-Link 本地烧录', icon: 'zap', command: 'mrsToolbox.openWchLinkUtility' },
              { kind: 'tool', label: 'ISP 编程工具', description: 'USB 直连烧录（CH58x 等）', icon: 'rocket', command: 'mrsToolbox.openIspTool' },
              { kind: 'tool', label: '触摸按键校准工具', icon: 'symbol-ruler', command: 'mrsToolbox.openTouchKeyTool' },
              { kind: 'tool', label: 'HEX/BIN 转换合并工具', icon: 'file-binary', command: 'mrsToolbox.openHexBinStudio' },
              { kind: 'tool', label: '设备管理器', icon: 'plug', command: 'mrsToolbox.openDeviceManager' },
              { kind: 'tool', label: '串口调试工具', description: 'COMTransmit', icon: 'terminal', command: 'mrsToolbox.openComTransmit' },
            ] as Row[])
          : []),
        { kind: 'tool', label: '串口终端', description: 'Serial Monitor', icon: 'terminal', command: 'mrsToolbox.openSerialTerminal' },
        ...(IS_WINDOWS
          ? ([
              { kind: 'tool', label: 'BLE 设备扫描', description: '扫描广播并复制 MAC', icon: 'radio-tower', command: 'mrsToolbox.scanBleDevices' },
              { kind: 'tool', label: 'BLE 调试助手', description: 'BLEDebug（官方 GUI）', icon: 'bluetooth', command: 'mrsToolbox.openBleDebug' },
              { kind: 'tool', label: 'Keil 工程转换器', icon: 'sync', command: 'mrsToolbox.openKeilConvert' },
            ] as Row[])
          : []),
        {
          kind: 'tool',
          label: IS_WINDOWS ? '安装链接驱动…' : '安装 udev 规则（设备权限）…',
          icon: 'zap',
          command: 'mrsToolbox.installLinkDriver',
        },
      ],
    });

    rows.push({
      kind: 'section',
      label: '串口',
      icon: 'plug',
      description: IS_WINDOWS ? '展开查看已连接的 COM 口' : '展开查看已连接的串口（/dev/tty*）',
      collapsed: true,
      loadChildren: async (): Promise<Row[]> => {
        const ports = await listSerialPorts();
        const rows: Row[] = ports.map((p) => ({
          kind: 'port',
          label: p.port,
          description: p.isWch
            ? `WCH · ${p.name.replace(/\s*\(COM\d+\)\s*$/, '') || p.name}`
            : p.name.replace(/\s*\(COM\d+\)\s*$/, '') || p.name,
          icon: 'plug',
          command: 'mrsToolbox.copySerialPort',
          commandArg: p,
        }));
        if (rows.length === 0) {
          rows.push({
            kind: 'info',
            label: '未检测到串口',
            description: '插上开发板后点下方刷新',
            icon: 'circle-slash',
          });
        }
        rows.push({
          kind: 'action',
          label: '刷新串口列表…',
          icon: 'refresh',
          command: 'mrsToolbox.refreshSerialPorts',
        });
        return rows;
      },
    });

    return rows;
  }
}
