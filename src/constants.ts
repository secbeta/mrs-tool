/**
 * Shared constants: probe patterns, series mapping, identifiers.
 */

export const EXT_ID = 'mrs-toolbox';
export const PROJECT_MARKER = '.mrs-project.json';
export const PROJECT_SCHEMA_VERSION = 1;

export const CTX_ACTIVE = 'mrsToolbox.active';
export const CTX_INSTALLED = 'mrsToolbox.installed';

/** File anchor used to validate a MounRiver Studio 2 installation. */
export const SUB_MANIFEST_REL =
  'resources/app/resources/win32/components/WCH/Toolchain/sub_manifest.json';
export const SDK_ROOT_REL = 'resources/app/resources/win32/components/WCH/SDK/default';
export const MAKE_BIN_REL = 'resources/app/resources/win32/others/Build_Tools/Make/bin';
export const OPENOCD_ROOT_REL = 'resources/app/resources/win32/components/WCH/OpenOCD/OpenOCD';
export const SWD_TOOL_REL = 'resources/app/resources/win32/components/WCH/Others/SWDTool/default';
export const ISP_TOOL_REL = 'resources/app/resources/win32/components/WCH/Others/WCHISPTool/default';
export const TOUCH_KEY_TOOL_REL =
  'resources/app/resources/win32/components/WCH/Others/WCHTouchKeyTool/default';
export const OTHERS_ROOT_REL = 'resources/app/resources/win32/others';
export const MRS_EXE_REL = 'MounRiver Studio 2.exe';

/** Curated per-drive probe patterns for the MRS2 install root. `%` = 盘符（含冒号，如 `D:`）。 */
export const PROBE_PATTERNS: readonly string[] = [
  // 历史 bug：模式写成 '%:/…' 而替换值是 'D:'（含冒号）→ 拼出 'D::/…' 恒不存在，
  // 扩展端被用户手填的 mounriverStudioPath 掩盖，CLI（无设置可读）才暴露。
  '%/MounRiver_Studio2',
  '%/MounRiver/MounRiver_Studio2',
  '%/tools/MR/MounRiver_Studio2',
  '%/Program Files/MounRiver_Studio2',
  '%/Program Files (x86)/MounRiver_Studio2',
];

/** Environment variable override (also used by tests). */
export const MRS2_HOME_ENV = 'MRS_TOOLBOX_MRS2_HOME';

/**
 * Example-library chip folder name → SDK series name (+ toolchain type).
 * Keys are UPPER-CASE — lookups use `.toUpperCase()` so `CH32V00x` matches
 * `CH32V00X`. Everything the EVT packages ship today; unknown folders fall
 * back to the wizard where the user picks a series manually.
 */
export const EXAMPLE_SERIES_MAP: Readonly<Record<string, { series: string; type: 'RISC-V' | 'ARM' }>> = {
  CH32V002: { series: 'CH32V002', type: 'RISC-V' },
  CH32V003: { series: 'CH32V003', type: 'RISC-V' },
  CH32V00X: { series: 'CH32V003', type: 'RISC-V' },
  CH32V007: { series: 'CH32V007', type: 'RISC-V' },
  CH32V10X: { series: 'CH32V103', type: 'RISC-V' },
  CH32V103: { series: 'CH32V103', type: 'RISC-V' },
  CH32V20X: { series: 'CH32V203', type: 'RISC-V' },
  CH32V30X: { series: 'CH32V307', type: 'RISC-V' },
  CH32X035: { series: 'CH32X035', type: 'RISC-V' },
  CH32L103: { series: 'CH32L103', type: 'RISC-V' },
  CH56X: { series: 'CH56X', type: 'RISC-V' },
  CH57X: { series: 'CH57X', type: 'RISC-V' },
  CH571: { series: 'CH57X', type: 'RISC-V' },
  CH573: { series: 'CH57X', type: 'RISC-V' },
  CH58X: { series: 'CH58X', type: 'RISC-V' },
  CH582: { series: 'CH58X', type: 'RISC-V' },
  CH583: { series: 'CH58X', type: 'RISC-V' },
  CH585: { series: 'CH585', type: 'RISC-V' },
  CH59X: { series: 'CH59X', type: 'RISC-V' },
  CH32F10X: { series: 'CH32F103', type: 'ARM' },
  CH32F103: { series: 'CH32F103', type: 'ARM' },
  CH32F20X: { series: 'CH32F205', type: 'ARM' },
  CH32F205: { series: 'CH32F205', type: 'ARM' },
};

/** gcc problem matcher definition (gcc 8/12 diagnostic format). */
export const GCC_PROBLEM_OWNER = 'mrs-toolbox-gcc';
