import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { pathExists, readJsonIfExists } from '../util/fsx';
import { deriveIsa, type TargetProcessorJson } from './isaMap';
import { ToolchainRegistry } from './toolchainRegistry';
import type { McuInfo, SeriesInfo, SdkInfo, TemplateManifest } from './types';

/** Parse the INI-like `.template` file shipped inside each template zip. */
export function parseTemplateManifest(text: string): TemplateManifest {
  const kv = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('[')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) {
      kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  const flag = (k: string) => kv.get(k)?.toLowerCase() === 'true';
  return {
    mcuType: kv.get('Mcu Type') ?? '',
    address: kv.get('Address') ?? '',
    targetPath: kv.get('Target Path') ?? '',
    eraseAll: flag('Erase All'),
    program: flag('Program'),
    verify: flag('Verify'),
    reset: flag('Reset'),
    vendor: kv.get('Vendor') ?? 'WCH',
    link: kv.get('Link') ?? 'WCH-Link',
    toolchain: kv.get('Toolchain') ?? 'RISC-V',
    series: kv.get('Series') ?? '',
    mcu: kv.get('MCU') ?? '',
    peripheralVersion: kv.get('PeripheralVersion'),
    description: kv.get('Description'),
  };
}

/** Read `.template` out of a template zip without extracting to disk. */
export function readZipTemplateManifest(zipPath: string): TemplateManifest | undefined {
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntries().find((e) => e.entryName === '.template');
    return entry ? parseTemplateManifest(entry.getData().toString('utf-8')) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Scans the MRS2 SDK directory (`SDK/default/{RISC-V,ARM}/<Series>/NoneOS/`)
 * into a chip database. Everything is discovered at runtime — new series and
 * MCUs appearing in future MRS2 releases work without code changes.
 */
export class ChipDatabase {
  private constructor(readonly sdk: SdkInfo) {}

  get series(): SeriesInfo[] {
    return this.sdk.series;
  }

  findSeries(name: string): SeriesInfo | undefined {
    return this.sdk.series.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  static async load(sdkRoot: string, toolchains: ToolchainRegistry): Promise<ChipDatabase> {
    const series: SeriesInfo[] = [];
    const version = (await readJsonIfExists<{ version?: string }>(path.join(sdkRoot, 'version.json')))
      ?.version;

    for (const type of ['RISC-V', 'ARM'] as const) {
      const typeDir = path.join(sdkRoot, type);
      if (!(await pathExists(typeDir))) {
        continue;
      }
      for (const entry of await fsp.readdir(typeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const seriesDir = path.join(typeDir, entry.name, 'NoneOS');
        if (!(await pathExists(seriesDir))) {
          continue;
        }
        const info = await loadSeries(seriesDir, entry.name, type, toolchains);
        if (info) {
          series.push(info);
        }
      }
    }

    return new ChipDatabase({ root: sdkRoot, version, series });
  }
}

async function loadSeries(
  seriesDir: string,
  name: string,
  type: 'RISC-V' | 'ARM',
  toolchains: ToolchainRegistry,
): Promise<SeriesInfo | undefined> {
  const tp = await readJsonIfExists<TargetProcessorJson>(`${seriesDir}/${name}-targetProcessor.json`);
  if (!tp) {
    return undefined;
  }

  const isa = deriveIsa(tp);
  const toolchain =
    (tp.component_toolchain ? toolchains.resolve(tp.component_toolchain) : undefined) ??
    toolchains.byTypeFirst(isa.arch === 'arm' ? 'ARM' : 'RISC-V');
  if (!toolchain) {
    return undefined;
  }

  const mcus: McuInfo[] = [];
  let mcuType: string | undefined;
  let svdFile: string | undefined;
  for (const f of fs.readdirSync(seriesDir)) {
    if (f.toLowerCase().endsWith('.zip')) {
      const id = f.slice(0, -4);
      const zipPath = path.join(seriesDir, f);
      mcus.push({ id, zipPath });
      if (!mcuType) {
        mcuType = readZipTemplateManifest(zipPath)?.mcuType;
      }
    } else if (f.toLowerCase().endsWith('.svd')) {
      // e.g. CH58Xxx.svd (the `-flash.json`/`-targetProcessor.json` files are excluded by suffix)
      svdFile = f;
    }
  }
  const svdPath = svdFile ? path.join(seriesDir, svdFile) : undefined;

  const flash = await readJsonIfExists<{ flash_address?: string }>(`${seriesDir}/${name}-flash.json`);

  mcus.sort((a, b) => a.id.localeCompare(b.id));
  return {
    name,
    type,
    isa,
    toolchain,
    mcuType,
    mcus,
    svdPath: svdPath ? path.join(seriesDir, svdPath) : undefined,
    flashAddress: flash?.flash_address,
  };
}
