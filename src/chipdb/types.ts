/** Data model for the chip database discovered from the MRS2 SDK layout. */

export type Arch = 'riscv' | 'arm';

export interface IsaInfo {
  arch: Arch;
  /** Full `-march=... -mabi=...` (RISC-V) or `-mcpu=... -mthumb` (ARM) flag string. */
  cpuFlags: string;
  /** gdb command selecting the architecture, `set architecture riscv:rv32` (RISC-V only). */
  gdbArchCmd?: string;
}

export interface ToolchainInfo {
  /** sub_manifest name: GCC8 | GCC12 | ARM */
  name: string;
  type: 'RISC-V' | 'ARM';
  /** Absolute bin directory. */
  binDir: string;
  /** e.g. `riscv-none-embed-` */
  prefix: string;
}

export interface McuInfo {
  /** Template zip stem, e.g. `CH582F`. */
  id: string;
  /** Absolute zip path. */
  zipPath: string;
}

export interface SeriesInfo {
  /** SDK series dir name, e.g. `CH58X`. */
  name: string;
  type: 'RISC-V' | 'ARM';
  isa: IsaInfo;
  /** Resolved via `${WCH:Toolchain:...}` from targetProcessor.json. */
  toolchain: ToolchainInfo;
  /** Template `Mcu Type` (e.g. `CH58x`) parsed from the first MCU zip, if any. */
  mcuType?: string;
  mcus: McuInfo[];
  /** Absolute SVD path for peripheral register view, when present. */
  svdPath?: string;
  /** From `<series>-flash.json`, informational. */
  flashAddress?: string;
}

export interface SdkInfo {
  root: string;
  version?: string;
  series: SeriesInfo[];
}

/** Parsed `.template` file from a template zip (INI-like, two sections). */
export interface TemplateManifest {
  mcuType: string;
  address: string;
  targetPath: string;
  eraseAll: boolean;
  program: boolean;
  verify: boolean;
  reset: boolean;
  vendor: string;
  link: string;
  toolchain: string;
  series: string;
  mcu: string;
  peripheralVersion?: string;
  /** Prose spec line, e.g. `ROM(byte): 448K, SRAM(byte): 32K, CHIP PINS: 48`. */
  description?: string;
}
