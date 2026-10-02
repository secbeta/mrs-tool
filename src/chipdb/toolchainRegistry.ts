import * as path from 'path';
import { readJsonIfExists } from '../util/fsx';
import type { ToolchainInfo } from './types';

interface SubManifestEntry {
  version: string;
  type: 'RISC-V' | 'ARM';
  name: string;
  path: string;
  compiler_c_executable?: { folder: string; name: string };
  debugger_executable?: { folder: string; name: string };
  other_tool_prefix: string;
}

interface SubManifest {
  version: string;
  id: string;
  details: SubManifestEntry[];
}

export class ToolchainRegistry {
  private readonly byName = new Map<string, ToolchainInfo>();
  private readonly byType = new Map<string, ToolchainInfo>();

  get names(): string[] {
    return [...this.byName.keys()];
  }

  resolve(nameOrRef: string): ToolchainInfo | undefined {
    // Accepts both the plain name (`GCC8`) and the manifest reference form
    // (`${WCH:Toolchain:GCC8}` → last segment).
    const name = nameOrRef.startsWith('${')
      ? (nameOrRef.slice(2, -1).split(':').pop() as string)
      : nameOrRef;
    return this.byName.get(name) ?? this.byType.get(nameOrRef);
  }

  /** First toolchain of a given type (used to default new ARM/RISC-V projects). */
  byTypeFirst(type: 'RISC-V' | 'ARM'): ToolchainInfo | undefined {
    return this.byType.get(type);
  }

  static async load(toolchainRoot: string): Promise<ToolchainRegistry> {
    const reg = new ToolchainRegistry();
    const manifest = await readJsonIfExists<SubManifest>(
      path.join(toolchainRoot, 'sub_manifest.json'),
    );
    if (!manifest) {
      return reg;
    }
    for (const d of manifest.details) {
      const info: ToolchainInfo = {
        name: d.name,
        type: d.type,
        binDir: path.join(toolchainRoot, d.path, d.compiler_c_executable?.folder ?? 'bin'),
        prefix: d.other_tool_prefix,
      };
      reg.byName.set(d.name, info);
      // First entry of a type wins for byType lookups (GCC8 before GCC12).
      if (!reg.byType.has(d.type)) {
        reg.byType.set(d.type, info);
      }
    }
    return reg;
  }
}
