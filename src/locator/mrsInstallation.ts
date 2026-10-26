import * as fs from 'fs';
import * as path from 'path';
import {
  ISP_TOOL_REL,
  IS_WINDOWS,
  MAKE_BIN_REL,
  MRS_EXE_CANDIDATES,
  MRS_EXE_REL,
  OPENOCD_ROOT_REL,
  OTHERS_ROOT_REL,
  SDK_ROOT_REL,
  SUB_MANIFEST_REL,
  SWD_TOOL_REL,
  TOUCH_KEY_TOOL_REL,
} from '../constants';
import { pathExists } from '../util/fsx';
import { ChipDatabase } from '../chipdb/chipDatabase';
import { ToolchainRegistry } from '../chipdb/toolchainRegistry';

/**
 * A validated MounRiver Studio 2/3 installation: every derived path is checked
 * against anchors that MRS upgrades keep stable (sub_manifest.json, SDK dir,
 * OpenOCD cfg files, Make\bin). Linux 与 Windows 布局同构（`resources/linux/`），
 * 差异只在可执行文件名（无 .exe）——由本类的 getter 吸收。
 */
export class MrsInstallation {
  private constructor(
    readonly root: string,
    readonly toolchains: ToolchainRegistry,
    readonly chipDb: ChipDatabase,
  ) {}

  get toolchainRoot(): string {
    return path.dirname(path.join(this.root, SUB_MANIFEST_REL));
  }

  get makeBin(): string {
    return path.join(this.root, MAKE_BIN_REL);
  }

  get makeExe(): string {
    return path.join(this.makeBin, IS_WINDOWS ? 'make.exe' : 'make');
  }

  get openocdRoot(): string {
    return path.join(this.root, OPENOCD_ROOT_REL);
  }

  get openocdExe(): string {
    return path.join(this.openocdRoot, 'bin', IS_WINDOWS ? 'openocd.exe' : 'openocd');
  }

  get openocdScripts(): string {
    return path.join(this.openocdRoot, 'scripts');
  }

  get sdkRoot(): string {
    return path.join(this.root, SDK_ROOT_REL);
  }

  /** MRS 主程序（MRS2/MRS3）；Linux 无 .exe 且文件名随版本有出入 → 按候选探测。 */
  get mrsExe(): string {
    for (const name of MRS_EXE_CANDIDATES) {
      try {
        const p = path.join(this.root, name);
        if (fs.existsSync(p)) {
          return p;
        }
      } catch {
        /* unreadable root — fall through */
      }
    }
    return path.join(this.root, MRS_EXE_REL);
  }

  get wchLinkUtilityExe(): string {
    return path.join(this.root, SWD_TOOL_REL, 'WCH-LinkUtility.exe');
  }

  /**
   * WCH ISP programming studio (components/WCH/Others/WCHISPTool). For chips
   * with a USB bootloader (CH55x/CH57x/CH58x/CH32…ISP-enabled) it flashes over
   * a plain USB cable — no WCH-Link needed.（Windows GUI；Linux 包不含，
   * 命令行 ISP 烧录走 wchisp，见 flash/ispFlasher。）
   */
  get ispToolStudioExe(): string {
    return path.join(this.root, ISP_TOOL_REL, 'WchIspStudio.exe');
  }

  /** WCH touch-key calibration tool (components/WCH/Others/WCHTouchKeyTool). */
  get touchKeyToolExe(): string {
    return path.join(this.root, TOUCH_KEY_TOOL_REL, 'WCHTouchKeyTool.exe');
  }

  /** Bundled serial-port utility (MRS2 others/COMTransmit). */
  get comTransmitExe(): string {
    return path.join(this.root, OTHERS_ROOT_REL, 'COMTransmit', 'COMTransmit.exe');
  }

  /** Bundled HEX/BIN merge & convert tool (MRS2 others/HexBinStudio). */
  get hexBinStudioExe(): string {
    return path.join(this.root, OTHERS_ROOT_REL, 'HexBinStudio', 'HexBinStudio.exe');
  }

  /** Bundled Keil → MRS project converter (MRS2 others/KeilConvert). */
  get keilConvertExe(): string {
    return path.join(this.root, OTHERS_ROOT_REL, 'KeilConvert', 'Program', 'ConvertProject.exe');
  }

  /** USB driver installers bundled with MRS2 (LinkDrv), for onboarding. */
  get linkDriverSetups(): { id: string; label: string; exe: string }[] {
    const linkDrv = path.join(this.root, OTHERS_ROOT_REL, 'LinkDrv');
    return [
      { id: 'wchlink', label: 'WCH-Link 驱动（调试 / 烧录必需）', exe: path.join(linkDrv, 'WCHLink', 'SETUP.EXE') },
      { id: 'wchlinkser', label: 'WCHLink 串口驱动（CH343）', exe: path.join(linkDrv, 'WCHLinkSER', 'SETUP.EXE') },
      { id: 'isp', label: 'CH32 ISP 驱动（CH375）', exe: path.join(linkDrv, 'ISP', 'SETUP.EXE') },
    ];
  }

  /**
   * Linux 版 MRS2 自带的 udev 规则（`beforeinstall/*.rules` 与
   * CommunicationLib 下的副本）：装入 /etc/udev/rules.d 后 WCH-Link / 串口
   * 免 root、免驱动即可用 —— Windows LinkDrv SETUP.EXE 的等价物。
   */
  get udevRuleFiles(): string[] {
    const dirs = [
      path.join(this.root, 'beforeinstall'),
      path.join(this.root, OTHERS_ROOT_REL, 'CommunicationLib', 'default'),
    ];
    const out: string[] = [];
    for (const dir of dirs) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.rules') && !out.some((p) => path.basename(p) === f)) {
            out.push(path.join(dir, f));
          }
        }
      } catch {
        /* dir missing — skip */
      }
    }
    return out;
  }

  get summary(): string {
    const riscv = this.chipDb.series.filter((s) => s.type === 'RISC-V').length;
    const arm = this.chipDb.series.filter((s) => s.type === 'ARM').length;
    const mcus = this.chipDb.series.reduce((n, s) => n + s.mcus.length, 0);
    return (
      `MounRiver Studio @ ${this.root}\n` +
      `Toolchains: ${this.toolchains.names.join(', ')}\n` +
      `Chip database: ${riscv} RISC-V + ${arm} ARM series, ${mcus} MCU templates\n` +
      `make: ${this.makeExe}\n` +
      `openocd: ${this.openocdExe}`
    );
  }

  /**
   * Validate a candidate root and parse everything we need from it.
   * Returns undefined (with a reason) when any anchor is missing.
   */
  static async load(
    root: string,
    opts: { sdkOverride?: string; toolchainOverrides?: Record<string, string> } = {},
  ): Promise<MrsInstallation | { error: string }> {
    const manifest = path.join(root, SUB_MANIFEST_REL);
    if (!(await pathExists(manifest))) {
      return { error: `no sub_manifest.json under ${root}` };
    }
    const toolchainRoot = path.dirname(manifest);
    const toolchains = await ToolchainRegistry.load(toolchainRoot);
    if (toolchains.names.length === 0) {
      return { error: `empty toolchain manifest at ${manifest}` };
    }
    for (const [name, dir] of Object.entries(opts.toolchainOverrides ?? {})) {
      if (dir) {
        const tc = toolchains.resolve(name);
        if (tc) {
          tc.binDir = dir;
        }
      }
    }

    const sdkRoot = opts.sdkOverride || path.join(root, SDK_ROOT_REL);
    if (!(await pathExists(sdkRoot))) {
      return { error: `SDK directory not found: ${sdkRoot}` };
    }
    const chipDb = await ChipDatabase.load(sdkRoot, toolchains);
    if (chipDb.series.length === 0) {
      return { error: `no chip series discovered under ${sdkRoot}` };
    }

    return new MrsInstallation(root, toolchains, chipDb);
  }
}
