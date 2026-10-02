MRS Toolbox 不捆绑任何工具链 —— 它直接复用本机已安装的 **MounRiver Studio 2**：

- RISC-V GCC8 / GCC12、ARM GCC（来自 `sub_manifest.json` 注册表，自动读取）
- make（含 sh.exe）、OpenOCD(WCH)、SDK 模板（147+ MCU）、SVD 文件

### 操作

1. 运行命令 **MRS Toolbox: Setup** —— 自动扫描常见位置与盘符
2. 探测失败或想换一份安装时：
   - 命令 **Set MounRiver Studio Path** 手动浏览选择安装目录
   - 或打开 **[配置页面](command:mrsToolbox.configure)**，在"MounRiver Studio 2 安装"一节点击"浏览…"，页面会实时显示从所选目录解析出的工具链、芯片库、make 与 openocd 路径

选定目录后，所有工具链位置都会自动推导，无需逐项填写。

[运行 Setup](command:mrsToolbox.setup)
