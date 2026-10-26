# MRS Toolbox

在 VS Code 里使用 **MounRiver Studio 2/3** 的工具链完成 WCH 单片机的开发：
新建工程、浏览例程库一键建工程、导入已有源码、编译、WCH-Link 烧录、
OpenOCD + GDB 断点调试、IntelliSense 配置生成。RISC-V 与 ARM 芯片全支持。

类似 ESP-IDF 扩展的体验，但**不捆绑任何工具链** —— 直接复用本机已安装的
MounRiver Studio 2 或 3（VS Code 内核版，组件布局同构；编译器 / make /
OpenOCD / SDK 模板 / SVD）。

## 前置条件

- [MounRiver Studio 2 或 3](https://www.mounriver.com/)（已安装即可，不需要
  运行它；**MRS3** 为 VS Code 内核版本，组件布局与 MRS2 同构，Setup 同样
  自动探测；路径可在设置里手动指定）
  - **Windows**：任意盘符下安装即可，Setup 自动探测（也扫全盘）
  - **Linux**：官网下载 MRS2 Linux 包解压（如解到 `~/Downloads/MRS2/`），
    得到 `MRS-linux-x64/` 安装根 —— Setup 会探测 `~/Downloads`、`~`、`/opt`、
    `/usr/share`、`/usr/local` 下的解压目录或安装根本身，手动浏览选中
    解压目录也可以
- VS Code ≥ 1.80
- 操作系统：**Windows 全功能**；**Linux** 自 0.2.18 起支持（编译 / 烧录 /
  调试 / 串口可用，GUI 工具差异见下节「Linux 差异说明」）；macOS 按 Linux
  布局处理（未经实测）
- 可选：[Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug)
  扩展（SVD 外设寄存器视图）；未安装时自动使用 cpptools (cppdbg) 调试配置

### Linux 差异说明

编译、WCH-Link 烧录（openocd）、断点调试、ISP 烧录（wchisp）、串口枚举 /
串口会话在 Linux 上全部可用；差异只有：

- **设备权限**：Linux 没有（也不需要）Windows 驱动安装器 —— 运行命令
  **Install WCH-Link / ISP Driver** 会给出把 MRS2 自带 udev 规则
  （`beforeinstall/*.rules`）装入 `/etc/udev/rules.d` 的一键复制命令；或者
  把用户加入 `dialout` 组（`sudo usermod -aG dialout $USER` 后重新登录）
- **GUI 工具**：WCH-LinkUtility / WchIspStudio / COMTransmit / HexBinStudio /
  Keil 转换器 / 触摸按键校准等仅随 Windows 版 MRS2 发行，Linux 侧边栏自动
  隐藏（命令行等价能力不受影响：烧录用 F8 / ISP，串口用 Serial Monitor 扩展）
- **BLE 调试**（`ble-scan` / `ble`）：基于 Windows WinRT 蓝牙栈，Linux 暂不可用
  （可用系统 `bluetoothctl` 等替代）
- **wchisp**：无需 DLL / 驱动 —— `cargo install wchisp` 或下载发行包后
  `chmod +x` 即可

## 快速开始

1. 安装扩展（`mrs-toolbox-0.2.18.vsix`：`code --install-extension mrs-toolbox-0.2.18.vsix`）
2. 运行命令 **MRS Toolbox: Setup** —— 自动探测 MRS2/MRS3 安装并在输出面板
   打印摘要（工具链、芯片库、openocd 路径）
3. 打开**配置页面**（命令 **MRS Toolbox: Open Configuration Page**，或
   侧边栏 / 状态栏的齿轮图标）：像 ESP-IDF 扩展一样图形化配置 ——
   - **MRS2 安装**：手动浏览选择安装目录，工具链/芯片库/make/openocd
     路径自动解析并展示；列出本机探测到的所有安装，一键切换；
     也可改回自动探测
   - **例程库管理**：添加多个例程库，每个库显示识别到的例程数与芯片列表，
     可打开/移除
   - **常用设置**：调试提供方、烧录后校验、擦除模式、openocd 端口
4. 三种方式建立工程：
   - **Create New Project**：向导选 架构 → 系列 → MCU → 位置，从 MRS2 SDK
     模板解出完整可编译工程
   - **例程库视图**（活动栏 MRS Toolbox → Examples）：按 库 → 芯片 →
     分类 → 例程 四层浏览，点击例程即创建工程。支持 MRS2 / MRS1 / Keil
     三种例程形态；视图工具栏 **+** 添加例程库，库节点可移除
   - **Import Existing Sources**：把已有源码目录原地变成工程（自动扫描
     srcDirs/libDirs/链接脚本，CH5xx 自动补 `CHIP_ID` 宏；Eclipse
     linkedResources 会在**所有**例程库中查找共享源码池）
5. **F7** 编译 / **Shift+F7** 重建 / **F8** 烧录（需 WCH-Link）；
   **Ctrl+Shift+B** 也直接编译（默认 Build Task）；**F5** 或 Debug 命令进入
   断点调试。编译/烧录完成时右下角弹出结果提示（含目标、配置与耗时）。
   工程不必位于工作区根目录 —— 嵌套在工作区任意子目录
   （最深 4 层）都能被自动发现；**多个工程并存时**首次执行编译/烧录/调试
   会弹工程选择框（目录名 + MCU + 相对路径），之后记住选择，点状态栏
   芯片徽标可随时重选；Run Task… 里每个工程各有 Build/Clean/Rebuild
6. **烧录工具按连接方式选**：WCH-Link 调试器接目标板 → **F8 烧录**（openocd，
   与 WCH-LinkUtility 同源）；CH55x/CH57x/CH58x 等带 USB Bootloader 的芯片
   用 USB 线直连电脑 → 命令 **Flash via ISP**（无需 WCH-Link，按住板上
   BOOT 键复位进入 ISP 模式；串口模式支持 CH32V00x 等无 USB ISP 的芯片）。
   ISP 走开源命令行工具 [wchisp](https://github.com/ch32-rs/wchisp)（扩展
   不捆绑；其 Windows 依赖 CH375DLL64.dll 与 ISP 驱动 MRS2 已自带，把
   wchisp.exe 放进 MRS2 的 WCHISPTool 目录即可，或用设置
   `mrsToolbox.ispToolPath` 指定）。GUI 版 **WchIspStudio** 仍在侧边栏
   "工具"分组（手动烧录备选）；该分组还有：触摸按键校准、HEX/BIN 转换
   合并、设备管理器、串口工具 COMTransmit、串口终端（Serial Monitor）、
   Keil 工程转换器、WCH-Link / 串口 / ISP 驱动安装 —— 与 WCH-LinkUtility
   的工具菜单一一对应
7. **看开发板在哪个串口**：命令 **Show Serial Ports** 或展开侧边栏"串口"
   分组 —— 列出所有 COM 口和适配器名称（CH340/CH343/WCH-Link 虚拟串口
   标记 WCH 并排最前）；点击端口即复制端口名，可直接打开 COMTransmit。
   WCH-LinkUtility 连上目标芯片时的"调试接口已开启"安全提示属正常行为，
   开发阶段选「是」即可（扩展首次启动时会提示一次）

首次安装还会出现入门指南（Walkthrough）：定位 MRS2 → 配置 → 建工程 → 编译。

## 生成的工程里有什么

```
<project>/
├── Makefile                # 由扩展生成（改 .mrs-project.json 后可重新生成）
├── .mrs-project.json       # 工程唯一事实源（芯片/源码目录/宏/输出）
├── AGENTS.md               # 构建指南（给 AI 助手 / CI / 命令行，见下节）
├── CLAUDE.md               # 一行 @AGENTS.md，Claude Code 自动加载
├── .vscode/c_cpp_properties.json   # IntelliSense（工具链编译器 + 头文件路径）
├── .vscode/launch.json     # cortex-debug + cppdbg 两套调试配置
├── obj/                    # 编译产物 .elf/.hex/.bin/.lst/.map
└── …                       # Core/Peripheral/Startup/Ld/User 等源码
```

Makefile 直接镜像 MRS2 的编译参数（`-ffunction-sections -fdata-sections …`、
nano.specs、`--gc-sections`），预编译库（如 `libCH58xBLE.a`）自动放进
`--start-group/--end-group`。

## CLI：命令行 / AI 会话（无头模式）

扩展命令活在 VS Code UI 里（向导、Generate Build Files、F7），CLI 会话与
其它 AI 助手够不着 —— 0.2.8 起同一套核心代码提供**无头 CLI**，迁移电脑或
在 Claude Code / Cursor 等会话里均可完整构建：

```bash
node <mrs-toolbox>/bin/mrs-toolbox.js doctor          # 检查 MRS2/工具链/工程（自动探测）
node <mrs-toolbox>/bin/mrs-toolbox.js build  <工程>   # 编译（--config debug 切 -Og -g3）
node <mrs-toolbox>/bin/mrs-toolbox.js rebuild <工程>  # clean + build
node <mrs-toolbox>/bin/mrs-toolbox.js flash  <工程>   # WCH-Link 烧录
node <mrs-toolbox>/bin/mrs-toolbox.js isp    <工程>   # ISP 直连烧录（USB/串口 Bootloader，
                                                 #     无需 WCH-Link；--port COMx 串口模式，
                                                 #     --tool 指定 wchisp；需 wchisp 见 doctor）
node <mrs-toolbox>/bin/mrs-toolbox.js gen    <工程>   # 重新生成 Makefile/IntelliSense/AGENTS.md
node <mrs-toolbox>/bin/mrs-toolbox.js create --mcu CH32V003F4P --dir <路径>   # 非交互建工程
node <mrs-toolbox>/bin/mrs-toolbox.js switch-mcu <工程> --mcu CH582M        # 同系列切换型号
node <mrs-toolbox>/bin/mrs-toolbox.js mcus             # 可用系列/MCU
node <mrs-toolbox>/bin/mrs-toolbox.js skills           # 生成例程库 AI skills（~/.claude/skills）
node <mrs-toolbox>/bin/mrs-toolbox.js ports            # 列出 COM 口与适配器（WCH 优先）
node <mrs-toolbox>/bin/mrs-toolbox.js serial --port COM5 --send ping --duration 3
                                                       # 打开串口→发送→采集→关闭（AI 与单片机通信）
node <mrs-toolbox>/bin/mrs-toolbox.js ble-scan         # 扫描 BLE 广播设备（需电脑蓝牙）
node <mrs-toolbox>/bin/mrs-toolbox.js ble --name ch583_ble_uart --list
                                                       # BLE 连接：GATT 表；去掉 --list 即
                                                       # UART 会话（自动识别 NUS/WCH/FFF0 透传，
                                                       # --send 写入 + 订阅通知采集）
```

安装成全局命令：`npm pack` 出 tgz 后 `npm i -g mrs-toolbox-0.2.17.tgz`，
即得 `mrs-toolbox build .`。MRS2 位置自动探测（也支持 `--mrs <根目录>` 或
环境变量 `MRS_TOOLBOX_MRS2_HOME`）。

**没有任何 mrs-toolbox 也不怕**：每个工程根自带的 `AGENTS.md` 写明了裸
`make` 与 openocd 烧录的完整命令（PATH 拼法用 `<MRS2>` 相对布局表示，换
电脑不失效），任何 AI 助手 / CI 照抄即可编译。`CLAUDE.md` 一行 `@AGENTS.md`
让 Claude Code 自动加载。

**例程库 → AI skill（换电脑 / 新 AI 会话免扫库）**：CLI `skills`（或命令
**Generate AI Skills**）把每个例程库沉淀成一个 skill，输出到
`~/.claude/skills/mrs-examples-<库名>/`（Claude Code 自动发现，其它 AI 助手
直接读文件）：

```
mrs-examples-<库名>/
├── SKILL.md          # 路由：芯片分表（目录/series/类型/例程数/分表文件）
│                     # + 三形态识别知识 + create --from-example 命令
└── refs/<芯片>.md    # 每块芯片一个分表：例程名称/形态/绝对路径，按分类分组
```

AI 的用法：读 SKILL.md 即知库里**有哪几块芯片、各在哪个分表**（表在文件
最前部，有读取截断也不会漏看后面的芯片）→ 按表读对应 `refs/<芯片>.md`
拿例程绝对路径 → `create --from-example` 建工程。例程增删后重跑 `skills`
即同步（幂等，只覆盖带生成标记的文件，手改过的保留）；库路径 `--lib <目录>`
显式指定（不指定则读 VS Code 设置里的例程库列表），输出目录 CLI 用
`--out <目录>`、扩展命令用设置 `mrsToolbox.aiSkillsDir` 改。


## 命令一览（分类 MRS Toolbox）

| 命令 | 说明 |
|---|---|
| Setup / Set Path | 定位与配置 MRS2 安装 |
| Open Configuration Page | 图形化配置（安装选择 / 例程库 / 常用设置） |
| Create New Project | 模板向导建工程 |
| Create Project from Example | 从例程库建工程 |
| Add / Remove Examples Library | 添加、移除例程库（可多个） |
| Generate AI Skills for Examples Libraries | 把例程库生成 AI skill 到 `~/.claude/skills`（每库一个：SKILL.md 路由 + 每芯片 `refs/<芯片>.md` 分表，见 CLI 节；例程增删后重跑即同步）——新 AI 会话无需重新扫库 |
| Import Existing Sources | 导入已有源码 |
| Switch MCU | 同系列切换型号（CH582F → CH582M；模板文件三方合并，改过的 Link.ld 等不会被覆盖） |
| Build / Clean / Rebuild | 编译（F7 / Shift+F7 / Ctrl+Shift+B） |
| Set Build Configuration | debug(-Og -g3) / release(-Os -g) |
| Flash / Build and Flash | openocd `program … verify reset`（F8） |
| Flash via ISP | wchisp USB/串口 Bootloader 直连烧录（无需 WCH-Link；CLI `mrs-toolbox isp` 同源，AI 可直接调用） |
| Erase Chip | 整片擦除（有确认） |
| Debug Project | 生成 launch.json 并启动调试 |
| Generate Build Files | 从 .mrs-project.json 重新生成 Makefile |
| Generate IntelliSense Configuration | 仅重新生成 IntelliSense 配置 |
| Open Project in MounRiver Studio 2 | 用 MRS2 打开工程目录 |
| Open WCH-LinkUtility | 打开 WCH 的烧录工具（装驱动/切模式） |
| Open Serial Tool (COMTransmit) | MRS2 自带串口助手 |
| Open HEX/BIN Tool (HexBinStudio) | HEX/BIN 合并转换工具 |
| Open Keil Project Converter | Keil 工程转换器 |
| Open WCH ISP Tool | USB 直连烧录（CH58x 等，无需 WCH-Link） |
| Open WCH Touch Key Tool | 触摸按键校准工具 |
| Open Device Manager | 设备管理器（串口号 / 驱动状态） |
| Open Serial Terminal | 串口终端（桥接 Serial Monitor 扩展） |
| Install WCH-Link / ISP Driver | 运行 MRS2 附带的驱动安装包（UAC） |
| Show Serial Ports | 列出 COM 口与适配器（WCH 优先），选择后复制 |

## 主要设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `mrsToolbox.mounriverStudioPath` | `""` | MRS2 安装根目录；留空自动探测（配置页面可浏览选择） |
| `mrsToolbox.examplesDirectories` | `[]` | 例程库目录列表（可添加多个） |
| `mrsToolbox.examplesDirectory` | `""` | 例程库目录（旧版单项设置，仍生效并与上面合并） |
| `mrsToolbox.debug.provider` | `auto` | `cortex-debug` / `cppdbg` / 自动 |
| `mrsToolbox.openocd.gdbPort` 等 | 3333/4444/6666 | openocd 端口 |
| `mrsToolbox.flash.verify` | `true` | 烧录后校验 |
| `mrsToolbox.ispToolPath` | `""` | wchisp 路径（ISP 直连烧录）；留空查 PATH |
| `mrsToolbox.aiSkillsDir` | `""` | AI skills 输出目录；留空 = `~/.claude/skills` |
| `mrsToolbox.toolchainOverride.*` | `""` | 高级：覆盖各工具链 bin 目录 |

## 已验证

- 芯片库发现：36 系列 / 147 个 MCU 模板（RISC-V + ARM）
- 模板新建 + 编译：CH32V003F4P、CH582F、CH32F103C8T → `.elf/.hex/.bin/.lst/.map`
- 从例程建工程 + 编译：CH32V00x GPIO_Toggle（MRS2 形态）、CH583 BLE
  Peripheral（MRS1 形态，SRC 池 + `libCH58xBLE.a` + `.highcode` + `CHIP_ID`）
- 导入：BLE 例程复制到临时目录后导入并编译成功（自动补齐共享源码池）
- **BLE 真机链路（CH583 + BLE_UART 例程，0.2.16）**：ISP 烧录 → `ble-scan`
  （可连接标记 / RSSI）→ `ble --list` GATT 表 → `ble --send` 会话（写
  Success + 板端 echo）；串口 → BLE 透传方向也实测：COM8 发往 UART3，
  `ble` 订阅端原样收到
- 烧录 / 调试需 WCH-LinkE + 目标板，命令与 MRS2 内部使用的 openocd/gdb
  参数一致

## 已知限制

- `.wvproj` 是加密格式：扩展不读不写它；与 MRS2 的互操作通过 `.cproject`：
  创建/重新生成构建文件时会按 `.mrs-project.json` 同步其头文件路径、宏、
  链接脚本、库与排除清单，MRS2 端与 VS Code 端编译一致（老工程在 MRS2 里
  报 `HAL.h: No such file or directory` 时，运行 **Generate Build Files**
  即可修复）。若 MRS2 已缓存旧配置仍报错，关闭 MRS2 后删除工程下 `.mrs`
  缓存目录再重新打开
- 串口终端依赖 VS Code 官方 Serial Monitor 扩展（未安装时提供安装入口与
  COMTransmit 兜底）；MRS2 内置的串口终端面板无法在外部复用
- 中文/空格路径下的工程已通过 argv 数组方式规避 shell 拼接问题，但建议
  工程路径保持 ASCII（make/工具链兼容性最好）
- BLE：CH58x 上 `GetGattServicesAsync(Uncached)` 会 E_UNEXPECTED（工具已
  全用 Cached 模式）；给板子**换固件后** Windows 可能仍返回按 MAC 缓存的
  旧 GATT 表（删设备节点、重启蓝牙都清不掉）——在系统设置里与设备**取消
  配对/移除**后重连，即返回新固件的真实表
- CH56X/CH57X 的 ARM 模板仅验证了编译；openocd 的 ARM 目标脚本以
  cortex-m3 为主

## 开发

```bash
npm install
npm run compile      # esbuild 打包到 dist/
npm test             # 单元测试（test/unit）
npm run verify       # 真实工具链端到端验证（需本机 MRS2）
npx vsce package     # 打 vsix
```
