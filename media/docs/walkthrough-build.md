工程就绪后（状态栏出现芯片徽标）：

| 按键 / 命令 | 动作 |
|---|---|
| **F7** | 编译（make，产物 `obj/*.elf/.hex/.bin/.lst/.map`， Problems 面板定位错误行） |
| **Shift+F7** | 重建（clean + build） |
| **F8** | 烧录（MRS2 的 OpenOCD + WCH-Link） |
| **F5** | 调试（OpenOCD + GDB，cortex-debug 或 cppdbg） |

- 编译参数镜像 MRS2（`-ffunction-sections -fdata-sections`、nano.specs、`--gc-sections`），预编译库自动进 `--start-group`
- 调试自动生成 launch.json：RISC-V 停在 `handle_reset`、ARM 停在 `main`，SVD 外设寄存器视图（需 cortex-debug）
- 烧录前可在[配置页面](command:mrsToolbox.configure)切换"烧录后校验"与擦除模式
- 需要装 WCH-Link 驱动或切换模式时：命令 **Open WCH-LinkUtility**

[立即编译](command:mrsToolbox.build)
