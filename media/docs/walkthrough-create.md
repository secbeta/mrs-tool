三种方式建立工程（活动栏 MRS Toolbox → 主视图"新建工程"分组）：

### 1. 从模板新建

**[Create New Project](command:mrsToolbox.createNewProject)** —— 向导依次选 架构（RISC-V / ARM）→ 系列 → MCU → 工程位置，从 MRS2 SDK 模板解出完整可编译工程（含 `.cproject/.project/.launch`，可在 MRS2 中互操作）。

### 2. 从例程创建

活动栏 **Examples** 视图：库 → 芯片 → 分类 → 例程 四层浏览（MRS2 / MRS1 / Keil 三种例程形态都支持），点击例程即创建工程。缺失的公共源码自动从 SDK 模板或库级共享源码池补齐。

- 例程库可在视图工具栏 **+** 添加，或在[配置页面](command:mrsToolbox.configure)管理
- 也可用命令 **[Create Project from Example](command:mrsToolbox.createProjectFromExample)** 快速搜索全部例程

### 3. 导入已有源码

**[Import Existing Sources](command:mrsToolbox.importProject)** —— 把已有源码目录原地变成工程：自动扫描 srcDirs / libDirs / 链接脚本，解析 Eclipse `.cproject`（defines/includes/链接资源），CH5xx 自动补 `CHIP_ID` 宏。
