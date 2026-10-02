/**
 * serialConsole.ts — 无头串口会话（CLI `serial` 子命令的后端）。
 *
 * Node 无内置串口；不引原生依赖的做法：PowerShell 的 .NET SerialPort
 * （Windows 必装，扩展本身也是 Windows 优先）。参数全部经**环境变量**传入
 * 固定脚本 —— 免命令行转义，CJK/引号/换行的发送内容都安全。
 *
 * 用途：AI 会话 / CI 里「打开串口 → 发若干行 → 采集 N 秒输出 → 关闭」，
 * 对应人工场景的串口终端。DTR/RTS 恒置位——多数 USB 芯片（CH340/CH343、
 * WCH-Link 虚拟串口）靠它才向 PC 上报数据。
 */
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

/** 组装会话环境变量（纯函数，单测覆盖）。 */
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
  const r = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SERIAL_PS_SCRIPT],
    { env: { ...process.env, ...buildSerialEnv(port, rest) }, timeoutMs: ((rest.durationSec ?? 3) + 15) * 1000, onLine },
  );
  if (r.code === 0) {
    return { ok: true, output: r.output };
  }
  let hint: string | undefined;
  if (/拒绝访问|access is denied|being used/i.test(r.output)) {
    hint = `串口 ${port} 被占用：关闭串口终端 / Serial Monitor / COMTransmit 后重试`;
  } else if (/不存在|does not exist|找不到/i.test(r.output)) {
    hint = `串口 ${port} 不存在：用 mrs-toolbox ports 查看当前端口`;
  }
  return { ok: false, output: r.output, hint };
}
