/**
 * Shared constants: probe patterns, series mapping, identifiers.
 */

export const EXT_ID = 'mrs-toolbox';
export const PROJECT_MARKER = '.mrs-project.json';
export const PROJECT_SCHEMA_VERSION = 1;

export const CTX_ACTIVE = 'mrsToolbox.active';
export const CTX_INSTALLED = 'mrsToolbox.installed';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * MRS2 tags its per-OS payload directory (`resources/app/resources/<win32|linux>/…`);
 * the layout below that segment is identical across OSes (Linux 包同为
 * components/WCH/…，仅平台段不同)。macOS（darwin）与其他平台按 linux 布局处理。
 */
const PLATFORM_DIR = IS_WINDOWS ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const MRS2_PAYLOAD = `resources/app/resources/${PLATFORM_DIR}`;

/** File anchor used to validate a MounRiver Studio 2/3 installation (MRS3 沿用同一 payload 布局). */
export const SUB_MANIFEST_REL = `${MRS2_PAYLOAD}/components/WCH/Toolchain/sub_manifest.json`;
export const SDK_ROOT_REL = `${MRS2_PAYLOAD}/components/WCH/SDK/default`;
export const MAKE_BIN_REL = `${MRS2_PAYLOAD}/others/Build_Tools/Make/bin`;
export const OPENOCD_ROOT_REL = `${MRS2_PAYLOAD}/components/WCH/OpenOCD/OpenOCD`;
export const SWD_TOOL_REL = `${MRS2_PAYLOAD}/components/WCH/Others/SWDTool/default`;
export const ISP_TOOL_REL = `${MRS2_PAYLOAD}/components/WCH/Others/WCHISPTool/default`;
export const TOUCH_KEY_TOOL_REL =
  `${MRS2_PAYLOAD}/components/WCH/Others/WCHTouchKeyTool/default`;
export const OTHERS_ROOT_REL = `${MRS2_PAYLOAD}/others`;

/**
 * 主程序候选文件名（按存在优先）。MRS3（VS Code 版）与 MRS2 共用候选表，
 * 装的是哪个版本、存在的那个即被选中。Linux 包无 .exe，主程序名带空格
 * （`mounriver-studio 2`，实测 MRS2 Linux V210；MRS3 的 bin/ 下为
 * `mounriver-studio 3`）。
 */
export const MRS_EXE_CANDIDATES: readonly string[] = IS_WINDOWS
  ? ['MounRiver Studio 3.exe', 'MounRiver Studio 2.exe']
  : process.platform === 'darwin'
    ? ['MounRiver Studio 3.app', 'MounRiver Studio 2.app']
    : ['mounriver-studio 3', 'MounRiver Studio 3', 'mounriver-studio 2', 'MounRiver Studio 2'];
export const MRS_EXE_REL = MRS_EXE_CANDIDATES[0];

/**
 * Linux/macOS 发行包（tar 解压）多出的根目录层：安装根是
 * `<解压目录>/MRS-linux-x64/…`。定位器对用户给出的任何目录都会顺带检查
 * 这一层，选中解压目录本身也能识别。Windows 安装器没有这一层。
 */
export const MRS_LINUX_DIR = 'MRS-linux-x64';

/** Curated per-drive probe patterns for the MRS2 install root (Windows). `%` = 盘符（含冒号，如 `D:`）。 */
export const PROBE_PATTERNS: readonly string[] = [
  // 历史 bug：模式写成 '%:/…' 而替换值是 'D:'（含冒号）→ 拼出 'D::/…' 恒不存在，
  // 扩展端被用户手填的 mounriverStudioPath 掩盖，CLI（无设置可读）才暴露。
  '%/MounRiver_Studio2',
  '%/MounRiver/MounRiver_Studio2',
  '%/tools/MR/MounRiver_Studio2',
  '%/Program Files/MounRiver_Studio2',
  '%/Program Files (x86)/MounRiver_Studio2',
  // MRS3（VS Code 版）沿用同一 components/WCH payload 布局，仅目录名带 3；
  // mrs3 是常见安装父目录（实测 C:\tool\mrs3\MounRiver_Studio3）。
  '%/MounRiver_Studio3',
  '%/MounRiver/MounRiver_Studio3',
  '%/mrs3/MounRiver_Studio3',
  '%/tool/mrs3/MounRiver_Studio3',
  '%/tools/mrs3/MounRiver_Studio3',
  '%/tools/MR/MounRiver_Studio3',
  '%/Program Files/MounRiver_Studio3',
];

/**
 * Linux/macOS 自动探测的基目录（`~` 在定位器里展开）。覆盖常见解压位置：
 * tar 包解到家目录 / ~/Downloads 是官方文档的默认姿势；AUR 等打包到
 * /usr/share/MRS2；自定义装 /opt、/usr/local。
 */
export const LINUX_PROBE_BASES: readonly string[] = [
  '~/Downloads',
  '~',
  '/opt',
  '/usr/share',
  '/usr/local',
];

/**
 * Linux/macOS 探测：基目录下按这些名字找安装根（`MRS-linux-x64` 是解压包
 * 自带的目录名；其余覆盖手工重命名 / 打包器的常见布局）。
 */
export const LINUX_PROBE_NAMES: readonly string[] = [
  MRS_LINUX_DIR,
  'MRS2',
  'MRS2/MRS-linux-x64',
  'MounRiver_Studio2',
  'MounRiver/MounRiver_Studio2',
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
