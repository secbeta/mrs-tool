import * as path from 'path';
import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';

/**
 * Environment for make invocations: MRS2's Make\bin (Windows 版自带的 sh.exe
 * 背书 `mkdir -p`/`rm -rf` 配方；Linux 上是原生 make) and the project
 * toolchain bin come first. Returns a plain string record (undefined values
 * dropped) as ProcessExecution requires.
 */
export function makeEnv(inst: MrsInstallation, proj: MrsProject): Record<string, string> {
  const toolchain = inst.toolchains.resolve(proj.mcu.toolchainName);
  const first = [inst.makeBin, ...(toolchain ? [toolchain.binDir] : [])];
  const pathVar = (process.env.PATH ?? process.env.Path ?? '') as string;
  const joined = [...first, pathVar].join(path.delimiter);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  env.PATH = joined;
  // Windows 下部分工具按 `Path` 读环境（键不区分大小写）；Linux 设置 `Path`
  // 反而会污染子进程环境，故只在 Windows 双写。
  if (process.platform === 'win32') {
    env.Path = joined;
  }
  return env;
}
