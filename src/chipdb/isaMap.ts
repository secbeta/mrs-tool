import type { IsaInfo } from './types';

/** Raw shape of `<Series>-targetProcessor.json`. */
export interface TargetProcessorJson {
  component_toolchain?: string;
  architecture?: string;
  multiply_extension?: boolean;
  atomic_extension?: boolean;
  floating_point?: string;
  compressed_extension?: boolean;
  extra_compressed_extension?: boolean;
  integer_ABI?: string;
  armFamily?: string;
  instructionSet?: string;
}

/**
 * Derive compiler CPU flags from a targetProcessor.json.
 *
 * RISC-V: march = architecture + m/a/f/c extension letters (f appended only
 * when floating_point != "none"), mabi = integer_ABI (rv32e → ilp32e default).
 * ARM: `-mcpu=<armFamily> -mthumb`.
 */
export function deriveIsa(tp: TargetProcessorJson): IsaInfo {
  if (tp.armFamily) {
    return { arch: 'arm', cpuFlags: `-mcpu=${tp.armFamily} -mthumb` };
  }

  const base = tp.architecture ?? 'rv32imac';
  let march = base;
  if (tp.multiply_extension) {
    march += 'm';
  }
  if (tp.atomic_extension) {
    march += 'a';
  }
  const hasFp = !!tp.floating_point && tp.floating_point !== 'none';
  if (hasFp) {
    march += 'f';
  }
  if (tp.compressed_extension || tp.extra_compressed_extension) {
    march += 'c';
  }

  const intAbi = tp.integer_ABI ?? (tp.architecture === 'rv32e' ? 'ilp32e' : 'ilp32');
  const mabi = hasFp ? intAbi + 'f' : intAbi;

  return {
    arch: 'riscv',
    cpuFlags: `-march=${march} -mabi=${mabi}`,
    gdbArchCmd: 'set architecture riscv:rv32',
  };
}
