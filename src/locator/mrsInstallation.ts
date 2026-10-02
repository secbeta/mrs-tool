import * as path from 'path';
import {
  ISP_TOOL_REL,
  MAKE_BIN_REL,
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
 * A validated MounRiver Studio 2 installation: every derived path is checked
 * against anchors that MRS upgrades keep stable (sub_manifest.json, SDK dir,
 * OpenOCD cfg files, Make\bin).
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
    return path.join(this.makeBin, 'make.exe');
  }

  get openocdRoot(): string {
    return path.join(this.root, OPENOCD_ROOT_REL);
  }

  get openocdExe(): string {
    return path.join(this.openocdRoot, 'bin', 'openocd.exe');
  }

  get openocdScripts(): string {
    return path.join(this.openocdRoot, 'scripts');
  }

  get sdkRoot(): string {
    return path.join(this.root, SDK_ROOT_REL);
  }

  get mrsExe(): string {
    return path.join(this.root, MRS_EXE_REL);
  }

  get wchLinkUtilityExe(): string {
    return path.join(this.root, SWD_TOOL_REL, 'WCH-LinkUtility.exe');
  }

  /**
   * WCH ISP programming studio (components/WCH/Others/WCHISPTool). For chips
   * with a USB bootloader (CH55x/CH57x/CH58x/CH32…ISP-enabled) it flashes over
   * a plain USB cable — no WCH-Link needed.
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

  get summary(): string {
    const riscv = this.chipDb.series.filter((s) => s.type === 'RISC-V').length;
    const arm = this.chipDb.series.filter((s) => s.type === 'ARM').length;
    const mcus = this.chipDb.series.reduce((n, s) => n + s.mcus.length, 0);
    return (
      `MounRiver Studio 2 @ ${this.root}\n` +
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
