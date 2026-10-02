import { runProcess } from '../util/proc';

/** One COM port as Windows sees it, with the adapter behind it. */
export interface SerialPortInfo {
  /** "COM7" */
  port: string;
  /** PnP caption, e.g. "USB-SERIAL CH340 (COM7)". */
  name: string;
  /** PnP instance id (carries VID/PID), when known. */
  pnpId?: string;
  /** WCH USB adapter (CH340/CH343/WCH-Link virtual COM …). */
  isWch: boolean;
}

/**
 * Enumerate COM ports without native dependencies. Primary source is
 * PowerShell over Win32_PnPEntity (captions like "USB-SERIAL CH340 (COM7)"
 * name the adapter, so the user can tell which port the board is on);
 * `reg query SERIALCOMM` is the fallback when PowerShell is unavailable.
 * Results are cached briefly so expanding the tree doesn't re-spawn shells.
 */

const PS_SCRIPT =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  "Get-CimInstance Win32_PnPEntity -Property Caption,DeviceID | " +
  "Where-Object { $_.Caption -match '\\(COM\\d+\\)' } | " +
  'ForEach-Object { "{0}|{1}" -f $_.DeviceID, $_.Caption }';

const REG_KEY = 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM';

const CACHE_TTL_MS = 3000;
let cache: { at: number; ports: SerialPortInfo[] } | undefined;

export function invalidateSerialPorts(): void {
  cache = undefined;
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  if (process.platform !== 'win32') {
    return [];
  }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.ports;
  }
  const ports = await enumerate();
  cache = { at: Date.now(), ports };
  return ports;
}

async function enumerate(): Promise<SerialPortInfo[]> {
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

/** WCH's USB VID is 1A86; also match by adapter name as a safety net. */
function isWchAdapter(text: string): boolean {
  return /VID_1A86/i.test(text) || /CH34\d|WCH[- ]?Link/i.test(text);
}

function portNumber(port: string): number {
  return parseInt(port.replace(/^COM/i, ''), 10) || 0;
}

/** WCH adapters first (the board the user is looking for), then by number. */
function sortPorts(ports: SerialPortInfo[]): SerialPortInfo[] {
  return [...ports].sort((a, b) => {
    if (a.isWch !== b.isWch) {
      return a.isWch ? -1 : 1;
    }
    return portNumber(a.port) - portNumber(b.port);
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
