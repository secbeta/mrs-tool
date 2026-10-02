import * as vscode from 'vscode';
import * as path from 'path';
import type { ToolboxContext } from '../toolbox';

/** Chip badge + quick build/flash/configure buttons, gated on mrsToolbox.active. */
export class StatusBar {
  private readonly chip: vscode.StatusBarItem;
  private readonly build: vscode.StatusBarItem;
  private readonly flash: vscode.StatusBarItem;
  private readonly gear: vscode.StatusBarItem;

  constructor(private readonly tbx: ToolboxContext) {
    const align = vscode.StatusBarAlignment.Left;
    this.chip = vscode.window.createStatusBarItem(align, 60);
    this.chip.command = 'mrsToolbox.selectProject';
    this.build = vscode.window.createStatusBarItem(align, 59);
    this.build.text = '$(gear) 编译';
    this.build.tooltip = 'MRS Toolbox: 编译 (F7 / Ctrl+Shift+B)';
    this.build.command = 'mrsToolbox.build';
    this.flash = vscode.window.createStatusBarItem(align, 58);
    this.flash.text = '$(zap) 烧录';
    this.flash.tooltip = 'MRS Toolbox: 烧录 (F8)';
    this.flash.command = 'mrsToolbox.flash';
    this.gear = vscode.window.createStatusBarItem(align, 57);
    this.gear.text = '$(settings-gear)';
    this.gear.tooltip = 'MRS Toolbox: 打开配置页面';
    this.gear.command = 'mrsToolbox.configure';
    this.gear.show();

    tbx.onDidChange(() => void this.update());
  }

  async update(): Promise<void> {
    const active = await this.tbx.activeProject();
    if (active) {
      const { proj, root } = active;
      const roots = await this.tbx.workspaceProjects();
      // With several projects the folder name tells them apart (MCU ids repeat);
      // the badge click always opens the project picker.
      this.chip.text =
        roots.length > 1 ? `$(chip) ${path.basename(root)}` : `$(chip) ${proj.mcu.mcuId}`;
      this.chip.tooltip = new vscode.MarkdownString(
        `**${proj.build.targetName}** — ${proj.mcu.series} · ${proj.mcu.toolchainName} · ${this.tbx.buildConfig}` +
          (roots.length > 1 ? `\n\n工作区共 ${roots.length} 个工程，点击切换` : '\n\n点击选择工程'),
      );
      this.chip.show();
      this.build.show();
      this.flash.show();
    } else {
      this.chip.hide();
      this.build.hide();
      this.flash.hide();
    }
  }

  dispose(): void {
    this.chip.dispose();
    this.build.dispose();
    this.flash.dispose();
    this.gear.dispose();
  }
}
