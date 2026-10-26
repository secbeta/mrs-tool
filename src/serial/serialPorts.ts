import * as fs from 'fs';
import * as path from 'path';
import { runProcess } from '../util/proc';

/** One serial port as the OS sees it, with the adapter behind it. */
export interface SerialPortInfo {
  /** "COM7" (Windows) or "/dev/ttyUSB0" (Linux). */
  port: string;
  /** Adapter caption, e.g. "USB-SERIAL CH340 (COM7)" / "USB-SERIAL CH340". */
  name: string;
  /** Windows PnP instance id or the /dev/serial/by-id name (carries VID/PID). */
  pnpId?: string;
  /** WCH USB adapter (CH340/CH343/WCH-Link virtual COM …). */
  isWch: boolean;
}

/**
 * Enumerate serial ports without native dependencies.
 * Windows: PowerShell over Win32_PnPEntity (captions like "USB-SERIAL CH340
 * (COM7)" name the adapter, so the user can tell which port the board is on);
 * `reg query SERIALCOMM` is the fallback when PowerShell is unavailable.
 * Linux/macOS: /dev 下的 tty 设备 + sysfs 读 USB 厂商/产品名（VID 1a86 = WCH）。
 * Results are cached briefly so expanding the tree doesn't re-spawn shells.
 */

const PS_SCRIPT =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  "Get-CimInstance Win32_PnPEntity -Property Caption,DeviceID | " +
  "Where-Object { $_.Caption -match '\\(COM\\d+\\)' } | " +
  'ForEach-Object { "{0}|{1}" -f $_.DeviceID, $_.Caption }';

const REG_KEY = 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM';

/** /dev 下参与枚举的 tty 设备（USB 串口 / CDC-ACM / 硬件 UART / 蓝牙 RFCOMM）。 */
const LINUX_TTY_RE = /^tty(USB\d+|ACM\d+|S\d+)$|^rfcomm\d+$/;

const CACHE_TTL_MS = 3000;
let cache: { at: number; ports: SerialPortInfo[] } | undefined;

export function invalidateSerialPorts(): void {
  cache = undefined;
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.ports;
  }
  const ports = process.platform === 'win32' ? await enumerateWin() : await enumerateLinux();
  cache = { at: Date.now(), ports };
  return ports;
}

async function enumerateWin(): Promise<SerialPortInfo[]> {
  const ps = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
    { timeoutMs: 15000 },
  );
  if (ps.code === 0) {
    return parsePnpPorts(ps.output);
  }
  const reg = await runProcess('reg.exe', ['query', REG_KEY], { timeoutMs: 10000 });
  return parseRegPorts(reg.output);
}

/**
 * Linux/macOS：枚举 /dev 下的 tty 设备；适配器名称与 WCH 识别走 sysfs
 * （/sys/class/tty/<name>/device 逐级上溯找 idVendor/manufacturer/product），
 * 零子进程、零原生依赖。
 */
async function enumerateLinux(): Promise<SerialPortInfo[]> {
  const out: SerialPortInfo[] = [];
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir('/dev')).filter((n) => LINUX_TTY_RE.test(n));
  } catch {
    return out;
  }
  for (const n of names) {
    const info = await describeLinuxPort(`/dev/${n}`);
    if (!out.some((p) => p.port === info.port)) {
      out.push(info);
    }
  }
  return sortPorts(out);
}

/** sysfs：从 device 目录向上（最多 4 层，USB-serial/CDC-ACM 层级不同）找 USB 信息。 */
async function describeLinuxPort(devPath: string): Promise<SerialPortInfo> {
  const ttyName = path.basename(devPath);
  let dir: string | undefined;
  try {
    dir = await fs.promises.realpath(`/sys/class/tty/${ttyName}/device`);
  } catch {
    dir = `/sys/class/tty/${ttyName}/device`;
  }
  let vid = '';
  let manufacturer = '';
  let product = '';
  for (let i = 0; i < 4 && dir; i++) {
    const [v, m, p] = await Promise.all([
      readSysFile(path.join(dir, 'idVendor')),
      readSysFile(path.join(dir, 'manufacturer')),
      readSysFile(path.join(dir, 'product')),
    ]);
    if (v) {
      vid = v;
      manufacturer = manufacturer || m;
      product = product || p;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  const pnpId = await findByIdName(devPath);
  const label = product || manufacturer || pnpId || '';
  return {
    port: devPath,
    name: label || devPath,
    pnpId: pnpId || undefined,
    // WCH's USB VID is 1a86; also match by adapter name as a safety net.
    isWch: vid === '1a86' || /CH34\d|WCH[- ]?Link|1a86/i.test(`${pnpId ?? ''} ${label}`),
  };
}

async function readSysFile(p: string): Promise<string> {
  try {
    return (await fs.promises.readFile(p, 'utf-8')).trim();
  } catch {
    return '';
  }
}

/** /dev/serial/by-id/<稳定名> 指向本端口时返回该名字（如 `usb-1a86_USB_Serial_…`）。 */
async function findByIdName(devPath: string): Promise<string> {
  try {
    const byId = '/dev/serial/by-id';
    for (const e of await fs.promises.readdir(byId)) {
      const real = await fs.promises.realpath(path.join(byId, e)).catch(() => '');
      if (real && real === devPath) {
        return e;
      }
    }
  } catch {
    /* no by-id dir */
  }
  return '';
}

/** WCH's USB VID is 1A86; also match by adapter name as a safety net. */
function isWchAdapter(text: string): boolean {
  return /VID_1A86/i.test(text) || /CH34\d|WCH[- ]?Link/i.test(text);
}

function portNumber(port: string): number {
  const m = /(\d+)$/.exec(port);
  return m ? parseInt(m[1], 10) || 0 : 0;
}

/** 设备名去掉尾部序号（"COM7"→"COM"，"/dev/ttyUSB0"→"/dev/ttyUSB"）。 */
function portBase(port: string): string {
  return port.replace(/\d+$/, '');
}

/** WCH adapters first (the board the user is looking for), then by name+number. */
function sortPorts(ports: SerialPortInfo[]): SerialPortInfo[] {
  return [...ports].sort((a, b) => {
    if (a.isWch !== b.isWch) {
      return a.isWch ? -1 : 1;
    }
    const base = portBase(a.port).localeCompare(portBase(b.port));
    return base !== 0 ? base : portNumber(a.port) - portNumber(b.port);
  });
}

/**
 * Parse "DeviceID|Caption" lines, keeping only captions that carry a COM
 * number. Pure function (unit-tested).
 */
export function parsePnpPorts(stdout: string): SerialPortInfo[] {
  const out: SerialPortInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/\(COM(\d+)\)/);
    if (!match) {
      continue;
    }
    const port = `COM${match[1]}`;
    if (out.some((p) => p.port === port)) {
      continue;
    }
    const sep = line.indexOf('|');
    const pnpId = sep >= 0 ? line.slice(0, sep).trim() : '';
    const name = sep >= 0 ? line.slice(sep + 1).trim() : line.trim();
    out.push({
      port,
      name: name || port,
      pnpId: pnpId || undefined,
      isWch: isWchAdapter(`${pnpId} ${name}`),
    });
  }
  return sortPorts(out);
}

/**
 * Parse `reg query SERIALCOMM` output — rows like
 * "    \Device\VCP0    REG_SZ    COM7". Port names only (no adapter info).
 * Pure function (unit-tested).
 */
export function parseRegPorts(stdout: string): SerialPortInfo[] {
  const out: SerialPortInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/(COM\d+)\s*$/);
    if (!match) {
      continue;
    }
    const port = match[1];
    if (out.some((p) => p.port === port)) {
      continue;
    }
    out.push({ port, name: port, isWch: false });
  }
  return sortPorts(out);
}
