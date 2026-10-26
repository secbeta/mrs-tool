/**
 * serialConsole.ts — 无头串口会话（CLI `serial` 子命令的后端）。
 *
 * Node 无内置串口，且不引原生依赖：
 * - Windows：PowerShell 的 .NET SerialPort（系统必装）。
 * - Linux：`stty` 配波特率/raw（util-linux 必装），`cat` 挂读流（tty 被打开
 *   即拉起 DTR/RTS——多数 USB 芯片（CH340/CH343、WCH-Link 虚拟串口）靠它
 *   才向 PC 上报数据），发送直接对设备文件追加写。
 * 两种后端的参数都经**环境变量 / 固定 argv**传入 —— 免命令行转义，
 * CJK/引号/换行的发送内容都安全。
 *
 * 用途：AI 会话 / CI 里「打开串口 → 发若干行 → 采集 N 秒输出 → 关闭」，
 * 对应人工场景的串口终端。
 */
import * as fs from 'fs';
import { runProcess } from '../util/proc';

/** 固定 PowerShell 脚本：读 MRS_TB_* 环境变量，永不内插用户数据。 */
export const SERIAL_PS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$p = New-Object System.IO.Ports.SerialPort($env:MRS_TB_PORT, [int]$env:MRS_TB_BAUD,',
  '    [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)',
  '$p.ReadTimeout = 200',
  '$p.DtrEnable = $true',
  '$p.RtsEnable = $true',
  'try {',
  '  $p.Open()',
  '  Start-Sleep -Milliseconds 150',
  '  if ($env:MRS_TB_SEND) {',
  '    foreach ($l in ($env:MRS_TB_SEND -split "`n")) { $p.Write($l); $p.Write($env:MRS_TB_EOL) }',
  '  }',
  '  $end = (Get-Date).AddSeconds([int]$env:MRS_TB_DURATION)',
  '  while ((Get-Date) -lt $end) {',
  '    $t = $p.ReadExisting()',
  '    if ($t.Length -gt 0) { [Console]::Out.Write($t) }',
  '    Start-Sleep -Milliseconds 30',
  '  }',
  '} finally { if ($p.IsOpen) { $p.Close() } }',
].join('\n');

export interface SerialSessionOptions {
  baud?: number;
  /** 依次写入的行（不带行尾，行尾由 eol 决定）。 */
  sendLines?: string[];
  /** 采集秒数（打开后总时长，含发送）。 */
  durationSec?: number;
  /** 行尾；默认 CRLF。 */
  eol?: 'crlf' | 'lf';
}

/** 组装会话环境变量（纯函数，单测覆盖；Windows 后端使用）。 */
export function buildSerialEnv(port: string, opts: SerialSessionOptions = {}): Record<string, string> {
  return {
    MRS_TB_PORT: port,
    MRS_TB_BAUD: String(opts.baud ?? 115200),
    MRS_TB_SEND: (opts.sendLines ?? []).join('\n'),
    MRS_TB_DURATION: String(opts.durationSec ?? 3),
    MRS_TB_EOL: opts.eol === 'lf' ? '\n' : '\r\n',
  };
}

export interface SerialSessionResult {
  ok: boolean;
  output: string;
  /** 失败归类提示（端口被占用等）。 */
  hint?: string;
}

/** 打开串口 → 可选发送 → 采集 → 关闭。输出流式回传。 */
export async function runSerialSession(
  port: string,
  opts: SerialSessionOptions & { onLine?: (line: string) => void } = {},
): Promise<SerialSessionResult> {
  const { onLine, ...rest } = opts;
  if (process.platform === 'win32') {
    const r = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SERIAL_PS_SCRIPT],
      {
        env: { ...process.env, ...buildSerialEnv(port, rest) },
        timeoutMs: ((rest.durationSec ?? 3) + 15) * 1000,
        onLine,
      },
    );
    if (r.code === 0) {
      return { ok: true, output: r.output };
    }
    return { ok: false, output: r.output, hint: detectSerialHint(port, r.output) };
  }
  return runSerialSessionLinux(port, rest, onLine);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Linux/macOS 后端：stty → cat 读流 + 设备文件直写（见文件头说明）。 */
async function runSerialSessionLinux(
  port: string,
  opts: SerialSessionOptions,
  onLine?: (line: string) => void,
): Promise<SerialSessionResult> {
  const durationSec = opts.durationSec ?? 3;
  const stty = await runProcess(
    'stty',
    ['-F', port, String(opts.baud ?? 115200), 'raw', '-echo'],
    { timeoutMs: 5000 },
  );
  if (stty.code !== 0) {
    return { ok: false, output: stty.output, hint: detectSerialHint(port, stty.output) };
  }

  // cat 挂上读流（打开即拉起 DTR/RTS）；到时 kill，采集到的输出仍完整回传。
  const reader = runProcess('cat', [port], {
    timeoutMs: durationSec * 1000 + 1000,
    onLine,
  });
  await sleep(150);

  let writeErr = '';
  const eol = opts.eol === 'lf' ? '\n' : '\r\n';
  for (const line of opts.sendLines ?? []) {
    try {
      await fs.promises.appendFile(port, line + eol);
    } catch (e) {
      writeErr = String((e as Error).message ?? e);
      break;
    }
  }

  const r = await reader;
  if (writeErr) {
    return { ok: false, output: `${r.output}\n${writeErr}`, hint: detectSerialHint(port, writeErr) };
  }
  // 正常路径：cat 挂满时长后被 timeout kill（exit null）。cat 自行退出
  // （exit 1，如设备不存在 / 无权限）= 打开失败。
  if (typeof r.code === 'number') {
    return { ok: false, output: r.output, hint: detectSerialHint(port, r.output) };
  }
  return { ok: true, output: r.output };
}

/** 失败输出归类成可操作的提示（Windows / Linux 输出都覆盖）。 */
function detectSerialHint(port: string, output: string): string | undefined {
  if (/拒绝访问|access is denied|being used|EACCES|permission denied/i.test(output)) {
    return process.platform === 'win32'
      ? `串口 ${port} 被占用：关闭串口终端 / Serial Monitor / COMTransmit 后重试`
      : `无权限打开 ${port}：把用户加入 dialout 组后重新登录（sudo usermod -aG dialout $USER），或安装 MRS2 自带的 udev 规则（命令面板 "Install WCH-Link / ISP Driver" 可复制安装命令）`;
  }
  if (/不存在|does not exist|找不到|no such file|not a tty/i.test(output)) {
    return `串口 ${port} 不存在：用 mrs-toolbox ports 查看当前端口`;
  }
  return undefined;
}
