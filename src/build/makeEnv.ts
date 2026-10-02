import type { MrsInstallation } from '../locator/mrsInstallation';
import type { MrsProject } from '../project/projectModel';

/**
 * Environment for make invocations: MRS2's Make\bin (its sh.exe backs
 * `mkdir -p`/`rm -rf` recipes) and the project toolchain bin come first.
 * Returns a plain string record (undefined values dropped) as ProcessExecution
 * requires.
 */
export function makeEnv(inst: MrsInstallation, proj: MrsProject): Record<string, string> {
  const toolchain = inst.toolchains.resolve(proj.mcu.toolchainName);
  const first = [inst.makeBin, ...(toolchain ? [toolchain.binDir] : [])];
  const pathVar = (process.env.PATH ?? process.env.Path ?? '') as string;
  const joined = [...first, pathVar].join(';');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  env.PATH = joined;
  env.Path = joined;
  return env;
}
