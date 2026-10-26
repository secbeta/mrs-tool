# Changelog

## 0.2.18

适配 MRS3（MounRiver Studio 3，VS Code 版）：其 payload 布局与 MRS2 完全
同构（resources/app/resources/win32/components/WCH/…），此前探测模式与主
程序候选只认 MRS2，装了 MRS3 的机器扫不到、命令也拉不起 IDE。

- **探测**：PROBE_PATTERNS 增加 MounRiver_Studio3 系列模式（含 mrs3 父目
  录布局，实测 C:\tool\mrs3\MounRiver_Studio3）；Windows 盘符浅扫的 l1 目
  录扩展匹配 mrs/mrs3 这类安装父目录（如 C:\mrs3\MounRiver_Studio3）
- **主程序**：MRS_EXE_CANDIDATES 增加 MRS3 候选（Windows `MounRiver
  Studio 3.exe`；Linux bin/ `mounriver-studio 3`），装哪个版本就拉起哪个
- **工具链零改动**：ToolchainRegistry 本就动态解析 sub_manifest.json，
  MRS3 清单里的 GCC8 / GCC12 / GCC15（riscv32-wch-elf-*）/ ARM 自动注册
- 版本相关文案中性化：CLI 输出、Setup/启动提示、walkthrough、设置说明、
  package.json description 等 "Studio 2" → "Studio 2/3" 或去版本号
- README：简介与前置条件明确 MRS2/MRS3 双版本支持；标注 Linux 跨平台
  支持自本版起（含「Linux 差异说明」一节）

## 0.2.17

例程 skill 防读取截断重构：AI 只看到第一块芯片的例程、后面的芯片全部"失踪"
——根因是单文件 SKILL.md 按芯片顺序内嵌全部例程清单（455 行），有读取行数/
字数截断的 AI 消费端只能读到第一块芯片（CH32F103 的 98 个例程占掉目录区前
~190 行）。

- **SKILL.md 瘦身为路由**：形态知识 + 建工程命令 + **芯片分表**（芯片目录 /
  series / 类型 / 例程数 / 分表文件一张表，放在正文最前部——截断再狠也能
  看到库里有哪些芯片）；不再内嵌任何例程条目
- **例程清单按芯片拆分表**：`refs/<芯片slug>.md`（如 `refs/ch32f103.md`），
  单芯片 ~60-110 行，任何消费端都能整读；内容格式与原清单一致（分类分组 +
  名称/形态/绝对路径）
- 写入语义不变：只覆盖带生成标记的文件（SKILL.md 与分表各自独立判定）；
  SKILL.md 被手改 → 整库跳过；库内芯片目录消失 → 对应分表自动清理；
  `writeExampleSkills` 返回结构与两处调用方（CLI `skills` / 扩展命令）零改动
- **公开发布清障（去除机器特定路径）**：`examplesDirectory` 旧版设置的
  默认值不再指向开发机路径（package.json 与 CLI shim 均改空——本机请改用
  `examplesDirectories` 设置或 CLI `--lib` 显式指定）；生成的 AGENTS.md 文案
  里 MRS2 路径示例改中性；scripts 下本机路径集中到被 gitignore 的
  `scripts/local.json`（模板见 verify-e2e.js 注释）

## 0.2.16

AI 的蓝牙（BLE）眼睛和嘴巴：CLI `ble-scan` / `ble`，走 Windows 自带 WinRT
蓝牙栈 —— 与 WCH 官方 BLEDebug 工具同一底层（其 WCHBLEDLL.dll 实为 WinRT
封装，PE 字符串核实），不捆绑任何二进制。

- **`mrs-toolbox ble-scan [--duration 5] [--name 过滤]`**：扫描 BLE 广播
  （名/MAC/RSSI/可连接标记，按 RSSI 排序）；广播与通知事件由 C# 委托回调
  直入并发集合
- **`mrs-toolbox ble (--addr MAC|--name 广播名) [--list] [--service U]
  [--char U] [--send 行]… [--duration 8]`**：连接设备 —— `--list` 列 GATT
  服务/特征及属性；默认 UART 会话：自动识别三套 WCH 常见透传配置（Nordic
  UART `6E400001-…` / 旧版 WCH `49535343-…` / 16 位 `FFF0` 系），写 RX →
  CCCD 订阅 TX → 采集通知（文本或 hex）；也可 `--service/--char` 显式指定。
  `--name` 无 addr 时自动扫描解析（要求唯一匹配）
- **VS Code 侧**：`Scan BLE Devices`（QuickPick 结果 → 复制 MAC）、
  `Open BLE Debug Tool`（启动官方 BLEDebug GUI，新设置 `mrsToolbox.bleDebugPath`，
  未找到给下载页提示）、工具树两行、doctor 新增 `ble(radio)` 行
- 工程的 AGENTS.md CLI 速查表新增 ble-scan / ble 两行

**实现踩坑实录**（PowerShell 5.1 + WinRT 的全链路，供后人）：

- **临时 .ps1 必须带 UTF-8 BOM**：无 BOM 时 `powershell -File` 按本地码页
  （GBK）读，中文注释的尾部字节会把换行吞进多字节序列 → 下一行代码被并进
  注释**静默消失**。本项目整整一晚的"玄学"（`$m` 莫名为 null、报错行号与
  文件对不上、同一脚本两跑结果不同）全是这个 —— 每次改注释，被吞的行就不同
- **Windows 安全中心会拦内联脚本**：`powershell -Command <约11KB脚本>` 的
  spawn 被 Defender 行为防御拦下（EPERM，内容签名触发，与脚本长度无关）；
  改写临时 .ps1 用 `-File` 启动后放行（AMSI 正常过）
- **Add-Type 编译不了引用 winmd 的 C#**：`-ReferencedAssemblies` 里的 winmd
  会被进程内加载校验打死（0x80131047）；本机 5.1 又没暴露 `-CompilerOptions`。
  → 直接调框架自带 csc.exe（`%WinDir%\Microsoft.NET\Framework[64]
  \v4.0.30319\csc.exe`）编译再 `Assembly.LoadFrom`
- **裸 winmd 编译三连**：winmd 类型派生自 facade 里的基类 → 需从 GAC 引
  `System.Runtime` 与 `System.Runtime.InteropServices.WindowsRuntime` 实际
  路径（CS0012）；WinRT 事件 `+=` 被 CS1545 禁、显式 `add_` 被 CS0571 禁
  → 编译期只构造 `TypedEventHandler<,>` 委托，运行时反射调投影类型的
  `add_` 访问器；C# 源码必须纯 ASCII + 写文件带 BOM（同 GBK 吞换行坑）
- **PS 内 `MakeGenericMethod` 反射不可靠**：`AsTask` 扩展方法的泛型具体化
  在 PS 里时灵时不灵 → 整个 Await（IAsyncOperation→Task 阻塞等结果）挪进
  C# 辅助类，确定性

**真机验证（CH583 板 + BLE_UART 例程，2026-09-10）**：create→build→ISP 烧录→
`ble-scan`（`*` 可连接标记 + RSSI）→`ble --list`（GATT 表）→`ble --send` 会话
（写 `Success` + 板端 echo 通知回收）全链路打通。又沉淀三条真机结论：

- **CH58x 上 `GetGattServicesAsync(Uncached)` 稳定 E_UNEXPECTED**（真连接也炸）
  → 脚本全用默认 Cached。但 **Cached 命中的是 BTHPORT 按 MAC 缓存的旧表**：
  本机给板子换固件后，Windows 仍返回上一版固件的 GATT 表（本例是张 HID 表），
  且针对性 UUID 查询也返回 0 —— **解法 = 取消配对**（`UnpairAsync` 或系统设置
  里移除设备），下一次 GATT 枚举即返回新固件的真实表；删 BTHLEDEVICE PnP
  节点、重启蓝牙无线电都清不掉这个缓存，取消配对才行
- **写特征三连坑**：PS 里调不了 `WriteValueAsync(IBuffer, GattWriteOption)`
  （IBuffer 以 `__ComObject` 形态进 PS，2 参重载解析必挂）；挪进 C# 直调也不
  行（返回的操作对象与本上下文的投影接口身份对不上，Await 转换炸）→ 与事件
  钩同一配方收尾：编译期类型反射拿 `MethodInfo`、运行时对 RCW `Invoke`、
  Await 的泛型参数取自方法自身 `ReturnType`
- **扫描的可连接标记被 scan response 抹掉**：设备 ADV_IND 与 SCAN_RSP 成对
  到达，后者类型非 `Connectable*`，收集表 last-frame-wins 就把 `*` 抹了
  （ch583_ble_uart 连续 4 轮扫描全无星号，逐帧 dump 证实一半帧是
  ConnectableUndirected）→ 标记改为 once-yes-always-yes
- 例程附四个互斥 `ble_uart_service*.c` 变体，本次编译存活的是 16 位 `FFF0`
  系（FFF1 notify / FFF2 write）——CLI 的三套自动识别配置表正好覆盖

## 0.2.15

修复 CLI 可重复旗标（`--send` / `-D` / `--lib` / `--search-root`）自 0.2.8 起全部静默失效。

- **根因**：参数解析把可重复旗标的值存进以**原始旗标名**（如 `'--send'`）为键的
  map，而各命令用**短名**（`multi.get('send')`）读取 —— 取值永远为空且无任何
  报错。受影响的四条路径：
  - `serial --send`：串口只收不发（2026-09-10 双串口对测暴露：COM4 收到了
    用户的 `https://wch.cn`，但发往 COM5 的问候语从未上线）
  - `create -D` / `--define`：自定义宏从未传给编译器
  - `create --search-root`：导入源码池回退查找目录从未生效
  - `skills --lib`：显式指定例程库被忽略（此前能工作纯靠 shim 默认值兜底）
- **修复**：解析器抽出为 `src/cli/args.ts`（便于单测），multi 旗标的存储键
  与读取键统一为短名，`-D` 与 `--define` 合并到同一键；缺值从 `die` 改为
  抛错由 main 统一处理。新增 3 组单测覆盖累积/规范化/缺值
- 单值旗标（`--port`/`-c`/`-j`/`-b` 等）此前就走短名规范化，不受影响

## 0.2.14

AI 的串口眼睛和嘴巴：CLI `ports` / `serial`。

- **`mrs-toolbox ports`**：列出 COM 口与适配器名称（WCH 适配器排最前，
  `*` 标注）—— 与扩展的 Show Serial Ports 同源（复用 serialPorts.ts 枚举：
  PowerShell Win32_PnPEntity，回退 reg query SERIALCOMM），但 CLI 化后 AI
  可直接调用
- **`mrs-toolbox serial [--port COMx] [-b 波特率] [--send 行]… [--duration 秒]
  [--eol crlf|lf]`**：打开串口 → 依次发送 → 采集输出 → 关闭。实现走
  PowerShell .NET SerialPort（零新依赖）；参数经环境变量传入固定脚本，
  CJK/引号/换行内容无需转义；DTR/RTS 恒置位（多数 USB 芯片靠它上报数据）。
  唯一串口时免 `--port`；多串口时列出候选并要求指定；被占用/不存在归类为
  中文提示
- 工程的 AGENTS.md CLI 速查表新增 ports / serial 两行（烧完固件即可通信）

## 0.2.13

例程库结构沉淀为 AI skill —— 新 AI 会话不再重新扫库。

- **`Generate AI Skills` 命令 + CLI `skills [--lib <库>]… [--out <目录>]`**：
  每个例程库生成一个 Claude Code skill（默认 `~/.claude/skills/mrs-examples-
  <库名>/SKILL.md`，其它 AI 助手可直接读）。内容：三种例程形态（mrs2/mrs1/
  keil）的识别与结构差异 + 建工程时扩展会补什么 + 全例程目录（绝对路径）+
  精确的 `create --from-example` 命令 —— 这些静态知识此前每个新 AI 会话
  都要重新扫描例程库现学一遍
- 粒度选**每库一个**而非每例程一个：237 个例程若各生成 skill 会灌爆每个
  会话的 skill 列表（Claude Code 每次会话加载全部 skill 名+描述）；库级
  skill 按需加载一次即覆盖全库
- **适应例程增删**：重跑即同步（内容比对，未变不写）；只覆盖带生成标记的
  文件，手改过的保留；库移除后其带标记的 skill 目录自动清理，用户自建的
  `mrs-examples-*` 目录绝不碰
- 新设置 `mrsToolbox.aiSkillsDir`（默认空 = `~/.claude/skills`，支持 `~/` 前缀）
- AGENTS.md CLI 速查表新增 `skills` 行；CLI shim 补例程库设置默认值
  （此前 CLI 读不到 VS Code 设置里的库列表）

## 0.2.12

工程自带 AI 文档升级为全量接口速查。

- 生成的 `AGENTS.md` 新增「附录：mrs-toolbox CLI 速查」：全部子命令总表
  （doctor/build/rebuild/clean/flash/isp/erase/gen/create/switch-mcu/mcus、
  全局 `--mrs`、`[dir]` 可省略规则），并注明 VS Code QuickPick 类命令对
  AI 不可用、CLI 与扩展同源同能力 —— 之前只写该工程用得上的 5 条，其它
  子命令 AI 无从知晓（只能 `help` 自发现或翻扩展仓库 README）
- 存量工程的 AGENTS.md 在下次 `gen`（或扩展端 Generate Build Files）时
  自动刷新（首行含生成标记即覆盖，手改过的保留不动）

## 0.2.11

修复 0.2.10 的 wchisp 探测漏洞。

- **`resolveIspTool` 补查 MRS2 的 WCHISPTool 目录**：安装指引让用户把
  wchisp.exe 放进该目录（旁边就是其依赖的 CH375DLL64.dll 与驱动），但
  探测链只有 设置 → PATH，从没看过那个目录 —— 照指引装好后扩展/CLI 仍报
  "未找到 wchisp"。现在查找顺序为 显式路径（`--tool`）→ 设置
  `mrsToolbox.ispToolPath` → MRS2 WCHISPTool 目录 → PATH
- 设置描述与 README 同步更新

## 0.2.10

ISP 直连烧录可被 AI / 命令行调用（此前 ISP 入口只有 GUI）。

- **`Flash via ISP` 命令 + CLI `mrs-toolbox isp [dir] [--port COMx] [--device N]
  [--tool <wchisp>]`**：USB/串口 Bootloader 直连烧录工程 hex，**无需
  WCH-Link**。调用开源命令行工具 wchisp（ch32-rs，Rust）—— 扩展仍不
  捆绑任何二进制；选它而不是官方 WCHISPTool_CMD 的原因：官方版每次运行
  都必须传 `-c Config.ini`，而该 ini 只能由 GUI 版 WchIspStudio
  「Save UI Config」生成，纯命令行/AI 场景绕不开 GUI；wchisp 零配置
  `wchisp flash <hex>`（自动擦除-编程-校验-复位），hex/bin/elf 皆可
- 路径解析：`mrsToolbox.ispToolPath` 设置 → `--tool` 显式指定 → PATH
  查找。**零额外依赖**：wchisp 在 Windows 上需要的 CH375DLL64.dll 与
  ISP 驱动，MRS2 的 WCHISPTool 目录（`WchIspStudio.exe` 旁）已自带，
  把 wchisp.exe 放同目录即可复用；找不到工具时给出下载页与该目录路径
- VS Code 侧 QuickPick 选烧录方式：USB（默认，提示按住 BOOT 复位进
  ISP 模式）/ 串口（列 COM 口，WCH 适配器排前；CH32V00x 无 USB ISP
  只能串口）。失败输出归类为可操作中文提示（缺 DLL / 无 ISP 设备 /
  串口被占用）
- `doctor` 新增 `isp(wchisp)` 行；工程 AGENTS.md 新增「烧录方式二：ISP」
  一节（裸 wchisp 命令，任何 AI 会话不装扩展也能照抄）
- 修复 `doctor` 在无工程目录下退出码恒为 1：工程查找里的 `process.exit`
  穿透了 try/catch（摘要照打但 CI/AI 按退出码判定会误判失败）
- 官方 WCHISPTool_CMD 不集成的同样原因记录在案：其 `-p/-c/-o/-f` 语法
  可用但强依赖 GUI 生成的 Config.ini

## 0.2.9

同系列切换 MCU 型号（如 CH582F → CH582M）。

- **`Switch MCU` 命令 + CLI `switch-mcu --mcu <ID>`**：把已有工程切到同系列
  其它型号。实测 SDK v2.8 同系列各型号 ZIP 的源码/外设库**逐字节相同**，
  差异只有 ①`.project/.launch/.template` 元数据；②内存不同时的
  `Ld/Link.ld`（CH32V203、CH585）或换名 `LD/<型号>.ld`（ARM CH32F103）；
  ③内核派生不同时的 Startup 排除表 + 设备头宏（V203 D6↔D8）。因此切换 =
  模板文件**三方合并**（旧模板为基准：用户改过的文件绝不覆盖，列入
  "保留"清单）+ 元数据原地改（自定义编译选项/排除路径/未知字段全保留）
  + 全量重新生成构建文件
- 自动处理：CHIP_ID 替换（CH582F→CH582M 不变、→CH583M 变）、
  targetName/flash.image 改名、launch.json 旧型号条目清理、
  `.project/.launch` 型号字符串替换、**obj/ 整目录清空**（make 不感知
  型号变化，旧 .o 会静默混链）、Startup 排除表跟随新模板
- QuickPick 列出同系列型号并显示 ROM/RAM/引脚数（`.template` Description）
- 防护：跨系列与外设库类型不同的特殊型号（CH32V203CCT 实为 V205 库）
  拒绝并提示新建工程；例程工程剥离过的模板 main 不会复活
- `TemplateManifest` 新增 `description` 字段

## 0.2.8

无头 CLI：扩展的全部能力不再只活在 VS Code UI 里。

- **`mrs-toolbox` CLI**（`node bin/mrs-toolbox.js` 或 `npm i -g` 后全局命令）：
  `doctor / gen / build / rebuild / clean / flash / erase / create / mcus`，
  与扩展共用 projectCreator / flasher / mrsLocator / makeEnv，不复制逻辑。
  实现：CLI 专属 vscode 替身（`src/cli/shim.ts`，钩 `Module.prototype.require`，
  OutputChannel → stdout），扩展核心模块零改动即可无头运行
- **每工程自动生成 `AGENTS.md` + `CLAUDE.md`**：写明裸 make 与 openocd 烧录
  完整命令（`<MRS2>` 相对布局，换电脑不失效）。任何 AI 助手 / CI 不装任何
  东西也能构建；含生成标记的 AGENTS.md 重生成时覆盖，手改过（标记消失）则保留
- **修复 MRS2 自动探测恒失败**：探测模式 `'%:/…'` 被替换成 `D::/…`（双冒号）
  —— 一直被用户手填的 mounriverStudioPath 掩盖，CLI 无设置可读才暴露
- **修复 `make -j rebuild` 竞态**：`rebuild: clean all` 在并行下 `all` 用
  删除前时间戳判定无事可做、`clean` 再删光 obj/，空产物退出 0。改为
  `+$(MAKE) clean` / `+$(MAKE) all` 递归串行
- `create` 子命令非交互（`--mcu/--dir/--from-example/-D`），供 AI 与脚本调用

## 0.2.7

MRS2 端编译修复 + 补齐 WCH 工具箱（ISP 直连烧录等）。

- **修复「VSCode 能编译、MRS2 打开后编译失败」**（`fatal error: HAL.h: No such
  file or directory` 之类）：MRS2 端从工程里的 Eclipse `.cproject` 生成自己的
  makefile，而从例程创建的工程保留的是 **SDK 模板**的 `.cproject`，其头文件
  路径（`../StdPeriphDriver/inc`）、链接脚本（`../Ld/Link.ld`）、库
  （`-l ISP583`）全部指向模板旁边的目录 —— 在新工程位置不存在，宏也与例程
  不符。现在创建/重新生成时会**按 `.mrs-project.json` 同步 `.cproject`**：
  头文件目录（递归收集，`${ProjName}` 工作区形式）、宏（含 `CHIP_ID`）、
  `-L` 库目录、`-l` 库名（从 `lib*.a` 推导）、链接脚本、sourceEntries 排除
  清单（互斥的 `ble_uart_service*.c` 变体等）。对新工程自动生效；**存量工程
  运行 Generate Build Files 即可修复**（本机 `CH582M_BLE_UART` /
  `CH582M_HID_Mouse` 已修复并用 MRS2 等效编译验证）
- **新增 WCH 工具箱**（对齐 WCH-LinkUtility 工具菜单，除计算器）：
  - **ISP 编程工具（WchIspStudio）**：CH55x/CH57x/CH58x 等带 USB Bootloader
    的芯片用 USB 线直连电脑烧录，**无需 WCH-Link**；首次打开提示如何进入
    ISP 模式（按住 BOOT 复位）
  - **触摸按键校准工具（WCHTouchKeyTool）**
  - **设备管理器**：查串口号 / 驱动状态
  - **串口终端**：桥接 VS Code 官方 Serial Monitor 扩展（未安装给安装入口，
    可回退 COMTransmit）—— MRS2 的串口终端是 IDE 内置面板，无法复用
  - 侧边栏「工具」分组按 WCH 菜单顺序重排（WCH-Link 烧录 → ISP → 触摸校准
    → HEX/BIN → 设备管理器 → 串口调试 → 串口终端 → Keil 转换）
- 修复 `.cproject` 解析器 include 路径匹配键（`include.paths` →
  `includePath`，此前解析结果恒为空）

## 0.2.6

编译 / 烧录完成时的右下角提示。

- **任务完成 toast**：监听任务系统（而非命令入口），F7 / Shift+F7、
  Ctrl+Shift+B、Run Task… 手动执行等**所有路径**统一在右下角弹出
  「编译完成: CH582M · debug · 4.2s」（清理/重建同理，含耗时与配置）；
  失败时弹错误提示（exit 码 + 去终端看详情），替代原先只在命令路径
  生效的失败提示
- **烧录 / 擦除 toast 升级**：成功提示带目标名与耗时（`烧录完成:
  CH582M · 3.1s`）；失败此前无 hint 时静默，现在也弹错误提示并指向
  输出面板 (MRS Toolbox Flash)

## 0.2.5

串口检测 + WCH-LinkUtility 弹窗说明。

- **串口检测**（无原生依赖）：新增命令 **Show Serial Ports**（QuickPick 列出
  所有 COM 口及适配器名称，WCH 适配器（CH340/CH343/WCH-Link 虚拟串口，
  VID 1A86）排最前）；主视图新增「串口」分组，展开即列出端口，点击端口
  复制端口名并可一键打开串口工具 COMTransmit，支持插拔后刷新。枚举走
  PowerShell `Win32_PnPEntity`（标题含 `(COMn)`），PowerShell 不可用时
  回退 `reg query SERIALCOMM`；结果缓存 3 秒避免重复拉起 shell
- **WCH-LinkUtility 启动弹窗说明**：该工具连上目标芯片时自带安全提示
  （调试接口已开启、代码可被读出，是否继续）——属正常行为而非启动失败；
  扩展首次启动该工具时会弹一次说明（开发阶段选「是」，量产请关闭调试
  接口并开启代码保护），之后不再打扰

## 0.2.4

多工程工作区的工程选择体验。

- **多工程时编译/烧录/调试先选工程**：工作区内发现多个工程且尚未记住
  选择时，`require()` 弹出 QuickPick（工程目录名 + MCU/系列 + 工作区相对
  路径），选择后记住，之后所有命令直接作用于该工程；点状态栏芯片徽标
  可随时重选。此前是"记住的选择 ?? 按路径排序的第一个"静默兜底
- **状态栏徽标区分同名工程**：多个工程时徽标显示工程目录名（MCU 型号
  会重复），tooltip 标注总数与切换入口；单工程仍显示 MCU 型号
- **任务列表按工程提供**：Run Task… 里为工作区每个工程提供
  Build/Clean/Rebuild（任务名含工程目录名）；默认 Build Task
  （Ctrl+Shift+B）= 当前活动工程的编译
- 工程/例程创建成功后立即刷新工程缓存，状态栏无需重载窗口即更新

## 0.2.3

修复"VSCode 端看不到编译选项"，并接入 MRS2 自带的其他工具。

- **嵌套工程发现**（根因修复）：此前只检查工作区**根目录**是否有
  `.mrs-project.json`，工程嵌在子目录里（如 `wch/ch582/test/CH582M`）时
  `mrsToolbox.active` 永远为 false —— 状态栏编译/烧录按钮、F7/F8 键位、
  侧边栏"操作"分组全部不出现。现递归扫描工作区（最深 4 层，跳过
  `.git`/`node_modules`/`obj`/点目录；命中标记后不再下钻），多工程时用
  状态栏芯片徽标切换
- **接入 MRS2 其他工具**（侧边栏"工具"分组 + 命令面板）：
  串口工具 COMTransmit、HEX/BIN 转换 HexBinStudio、Keil 工程转换器、
  WCH-Link / WCHLink 串口 / CH32 ISP 驱动安装（QuickPick 选择 + UAC 确认）
- 状态栏按钮中文化（编译 / 烧录）
- 编译任务设为默认 Build Task：**Ctrl+Shift+B** 直接编译当前工程
  （不支持的宿主退化为构建任务快速选择，任务仍在列）

## 0.2.2

修复"创建工程失败: ENOENT"及两类从例程/导入创建的深层问题。

- 新建工程时目标目录**不存在**（正常情形）直接崩溃：空目录检查
  `readdirSync` 未判存在性（命令层 bug，e2e 直调 createProject 故未暴露）
- 部分例程（如 CH583 BLE_UART）的 Eclipse 链接目录写在 `<location>` 标签
  而非 `<locationURI>`，`PARENT-n-PROJECT_LOC` 伪 URI 解析不到 →
  HAL/LIB 等共享目录没被拷入；现已两种标签都解析，且从例程创建与导入
  一样支持在所有例程库中回退查找缺失的链接目录
- 正确解析 Eclipse `sourceEntries` 的 `excluding=` 构建排除规则并镜像进
  Makefile（`filter-out`）：
  - 排除路径相对其所属条目的 `name`（`name="HAL"` 下的 `Profile` 意为
    `HAL/Profile`）
  - 若排除的文件夹同时被注册为独立 sourcePath 条目，则是防止重复计数
    而非真排除（GPIO_Toggle 根条目排除 `Startup|Peripheral|…`）
  - 解决 CH58x BLE 例程四个互斥 `ble_uart_service*.c` 变体全部参与编译
    导致的重复定义链接错误
- `.mrs-project.json` 新增 `build.excludedPaths`（旧工程文件兼容）
- e2e 新增 S8 门禁：CH583 BLE_UART 例程 → CH582M 目标、目标目录不存在，
  创建 + 编译 + 排除规则 + CHIP_ID 全链路校验

## 0.2.1

修复例程库扫描漏报（108 → 237）。

- 根因一：Keil/WCH 工程文件是**命名式**（`CH32F10x.uvprojx`、`GPIO_Toggle.wvproj`），
  此前按精确名 `.uvprojx` 匹配永远找不到，被迫用"子目录有 .c"启发式兜底，
  该启发式又把**分类目录**（ADC/BLE/…）误判成单个例程，其下所有真例程全部丢失
- 根因二：不支持三层嵌套分类（`USB/USBD/<例程>`、`USB/Device/<例程>`）
- 重写扫描：工程文件按后缀识别（`.cproject` 精确名 + `.uvprojx/.uvproj/.wvproj`
  后缀）→ 决定例程身份；其余目录作为分类容器递归下降（最深 4 层），
  分类标签自动拼接（如 `USB/USBD`）
- 跳过 `SRC` 共享源码池与 `obj`；`User/APP/` 等工程内源码目录、
  含预编译库的支持目录（`Udisk_Lib`/`TKYLIB`）不再误报为例程
- style 分类同步修复：keil / mrs2 / mrs1 正确识别
- 新增单元测试覆盖以上场景；e2e S7 门禁从 >50 加严到 >200 并校验
  风格、池排除、嵌套分类

## 0.2.0

图形化界面与多例程库支持。

- **配置页面**（命令 Open Configuration Page / 侧边栏齿轮 / 状态栏齿轮）：
  类 ESP-IDF 扩展的 webview 图形配置 —— MRS2 安装选择与解析结果展示、
  例程库管理、常用设置（调试提供方 / 烧录校验 / 擦除模式 / openocd 端口）、
  当前工程信息；面板关闭后可恢复
- **手动选择 MRS2 安装位置**：配置页面浏览选择目录，工具链 / 芯片库 /
  make / openocd 路径自动解析校验；列出本机探测到的所有安装，一键切换；
  可改回自动探测
- **多例程库**（类似 ESP-IDF 安装 ADF）：`mrsToolbox.examplesDirectories`
  数组设置，视图工具栏 **+** 添加、库节点移除；与旧版单项设置合并兼容
- Examples 视图增加库层级：库 → 芯片 → 分类 → 例程 四层浏览，
  空态欢迎页带"添加例程库"入口；导入工程的共享源码池在所有库中查找
- 主视图分组化（环境 / 工程 / 操作 / 新建工程 / 工具）；状态栏新增
  配置页齿轮按钮
- 入门指南（Walkthrough）：定位 MRS2 → 配置 → 建工程 → 编译 四步
- 市场图标

## 0.1.0

初始版本。

- MRS2 安装自动探测（设置 → 环境变量 → 常见路径模式 → 盘符浅扫 → 手动选择）
- 芯片库运行时发现：36 系列 / 147 MCU 模板，march/mabi 从
  targetProcessor.json 推导（RISC-V + ARM）
- 三路建工程：空白模板向导 / 例程库浏览一键创建（MRS2、MRS1、Keil 三种
  例程形态）/ 已有源码导入（Eclipse linkedResources 共享池自动补齐）
- Makefile 生成：递归源码发现、预编译库 `--start-group`、dep 文件、
  debug/release 双配置，编译参数镜像 MRS2 默认
- IntelliSense 配置生成（工具链编译器 + 递归 include）
- 构建任务集成：F7/Shift+F7 + gcc problem matcher（Problems 面板定位行号）
- WCH-Link 烧录 / 整片擦除（openocd），驱动缺失时给中文可操作提示
- 调试：launch.json 生成 cortex-debug（SVD 外设视图）与 cppdbg 双配置，
  停住点 RISC-V=handle_reset / ARM=main，与 MRS2 内部参数一致
- 例程视图（系列 → 分类 → 例程）与主视图三态欢迎页、状态栏芯片徽标
