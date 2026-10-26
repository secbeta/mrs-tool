/**
 * bleConsole.ts — AI 可调用的 BLE 调试（扫描 / GATT 列表 / UART 会话）。
 *
 * 与 0.2.14 的 serial 同一配方：固定 PowerShell 脚本 + MRS_TB_* 环境变量传参
 * （CJK/引号零转义），零新依赖。底层走 Windows 自带 WinRT BLE API —— 与 WCH
 * 官方 BLEDebug 工具同一蓝牙栈（其 WCHBLEDLL.dll 实为 WinRT 封装，2026-09-10
 * PE 字符串核实）。
 *
 * 输出行协议（TS 端解析 & 人可读）：
 *   DEV|<MAC>|<名或->|<RSSI>|<yes|no>     扫描结果
 *   SVC|<uuid> / CHR|<uuid>|<props逗号>   GATT 表
 *   TX|<行> (status) / RX|<文本或 hex:…>  会话收发
 *   LOG|<信息> / ERR|<CODE>|<详情>        进度与错误
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProcess } from '../util/proc';

export interface BleScanOptions { durationSec?: number; }

export interface BleSessionOptions {
  /** 逐行写入 RX 特征（UTF-8）；空 = 只订阅采集 */
  sendLines?: string[];
  /** 发送完后的采集窗口秒数 */
  durationSec?: number;
  /** 显式服务 UUID（覆盖自动识别） */
  serviceUuid?: string;
  /** 显式写特征 UUID（覆盖自动识别；TX 仍取服务内可通知特征） */
  charUuid?: string;
}

export interface BleDeviceInfo { mac: string; name: string; rssi: number; connectable: boolean; }
export interface BleCharacteristicInfo { uuid: string; props: string[]; }
export interface BleServiceInfo { uuid: string; characteristics: BleCharacteristicInfo[]; }
export interface BleRunResult<T> { ok: boolean; output: string; data?: T; hint?: string; }

/* ---------------- PowerShell 脚本（powershell.exe 5.1 + WinRT 投影） ---------------- */

/**
 * C# 辅助源码（PS 脚本头部 Add-Type 一次编译；C#5 语法 —— Add-Type 用老 csc）：
 * - Async.Await：IAsyncOperation<T> 反射成 Task<T> 阻塞等结果。曾用 PS 直接做
 *   MakeGenericMethod 反射，同一脚本两跑一成一败（PS 5.1 对投影程序集的成员解析
 *   不稳定，2026-09-10 实测），挪进 C# 后确定性。
 * - Scan / Rx：广播与通知事件用委托回调直入并发集合 —— 替代 Register-ObjectEvent
 *   （-NonInteractive 下事件泵不可靠，且 -Action 块无编译期检查）。
 */
const BLE_CS_HELPER = [
  'using System;',
  'using System.Collections.Concurrent;',
  'using System.Reflection;',
  'using System.Text;',
  'using System.Threading.Tasks;',
  'using Windows.Devices.Bluetooth;',
  'using Windows.Devices.Bluetooth.Advertisement;',
  'using Windows.Devices.Bluetooth.GenericAttributeProfile;',
  'using Windows.Foundation;',
  'using Windows.Storage.Streams;',
  '',
  'namespace MrsTbBle {',
  '  public static class Async {',
  '    static MethodInfo _asTask;',
  '    public static object Await(object op, Type t) {',
  '      if (_asTask == null) {',
  '        foreach (MethodInfo m in typeof(System.WindowsRuntimeSystemExtensions).GetMethods()) {',
  '          ParameterInfo[] p = m.GetParameters();',
  '          if (m.Name == "AsTask" && p.Length == 1 && p[0].ParameterType.Name == "IAsyncOperation`1") { _asTask = m; break; }',
  '        }',
  '        if (_asTask == null) { throw new InvalidOperationException("AsTask<T>(IAsyncOperation<T>) not found"); }',
  '      }',
  '      Task task = (Task)_asTask.MakeGenericMethod(t).Invoke(null, new object[] { op });',
  '      try { task.Wait(); } catch (AggregateException ae) { throw ae.GetBaseException(); }',
  '      return task.GetType().GetProperty("Result").GetValue(task, null);',
  '    }',
  '  }',
  '  public static class Scan {',
  '    public static ConcurrentDictionary<string, string> Table = new ConcurrentDictionary<string, string>();',
  '    // WinRT events under raw-winmd compile: += blocked by CS1545, explicit add_ by CS0571,',
  '    // so build the delegate at compile time and reflect-invoke the projected add_ accessor.',
  '    public static void Hook(BluetoothLEAdvertisementWatcher w) {',
  '      typeof(BluetoothLEAdvertisementWatcher).GetMethod("add_Received").Invoke(w, new object[] {',
  '        new TypedEventHandler<BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementReceivedEventArgs>(OnAdv) });',
  '    }',
  '    static void OnAdv(BluetoothLEAdvertisementWatcher s, BluetoothLEAdvertisementReceivedEventArgs e) {',
  '      try {',
  '        string mac = e.BluetoothAddress.ToString("X12");',
  '        string n = e.Advertisement.LocalName; if (string.IsNullOrEmpty(n)) { n = "-"; }',
  '        string conn = e.AdvertisementType.ToString().StartsWith("Connectable") ? "yes" : "no";',
  '        // Sticky connectable: ADV_IND 常跟 SCAN_RSP 成对，scan response 不是',
  '        // Connectable* 类型，last-frame-wins 会把可连接标记抹掉（真机实测',
  '        // ch583_ble_uart 连续 4 轮扫描全无 *，逐帧 dump 证实一半是 ConnectableUndirected）',
  '        string prior; if (conn == "no" && Table.TryGetValue(mac, out prior) && prior.EndsWith("|yes")) { conn = "yes"; }',
  '        Table[mac] = n + "|" + e.RawSignalStrengthInDBm + "|" + conn;',
  '      } catch { }',
  '    }',
  '  }',
  '  public static class Tx {',
  '    // 写不能从 PS 调（2 参重载解析不了 IBuffer 的 __ComObject），也不能在 C# 里',
  '    // 直调（返回的操作对象身份与本上下文的投影接口对不上）→ 与事件钩同配方：',
  '    // 编译期类型拿 MethodInfo，运行时对 RCW Invoke，结果类型取自方法自身 ReturnType',
  '    public static object WriteText(GattCharacteristic c, string s, object o) {',
  '      DataWriter dw = new DataWriter();',
  '      dw.WriteString(s);',
  '      object buffer = dw.DetachBuffer();',
  '      GattWriteOption opt = (GattWriteOption)Convert.ToInt32(o);',
  '      foreach (MethodInfo m in typeof(GattCharacteristic).GetMethods()) {',
  '        ParameterInfo[] p = m.GetParameters();',
  '        if (m.Name == "WriteValueAsync" && p.Length == 2) {',
  '          object op = m.Invoke(c, new object[] { buffer, opt });',
  '          Type rt = m.ReturnType.GetGenericArguments()[0];',
  '          object res = Async.Await(op, rt);',
  '          PropertyInfo pi = res.GetType().GetProperty("Status");',
  '          return pi == null ? "" + res : pi.GetValue(res, null).ToString();',
  '        }',
  '      }',
  '      throw new InvalidOperationException("WriteValueAsync(IBuffer, GattWriteOption) not found");',
  '    }',
  '  }',
  '  public static class Rx {',
  '    public static ConcurrentQueue<string> Q = new ConcurrentQueue<string>();',
  '    public static void Hook(GattCharacteristic c) {',
  '      typeof(GattCharacteristic).GetMethod("add_ValueChanged").Invoke(c, new object[] {',
  '        new TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs>(OnVal) });',
  '    }',
  '    static void OnVal(GattCharacteristic s, GattValueChangedEventArgs e) {',
  '      try {',
  '        DataReader dr = DataReader.FromBuffer(e.CharacteristicValue);',
  '        byte[] b = new byte[dr.UnconsumedBufferLength];',
  '        if (b.Length > 0) { dr.ReadBytes(b); }',
  '        string txt = Encoding.UTF8.GetString(b);',
  '        bool ascii = txt.Length > 0 && Array.TrueForAll(b, delegate(byte x) { return x < 128; });',
  "        Q.Enqueue(ascii ? \"RX|\" + txt : \"RX|hex:\" + BitConverter.ToString(b).Replace('-', ' '));",
  '      } catch (Exception ex) { Q.Enqueue(\"RX|decode-error: \" + ex.Message); }',
  '    }',
  '    public static string Drain() { string s; return Q.TryDequeue(out s) ? s : null; }',
  '  }',
  '}',
].join('\n');

export const BLE_PS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$ErrorActionPreference = "Stop"',
  'try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}',
  // C# 辅助：直接调框架自带 csc.exe 编译（源码见 BLE_CS_HELPER）。不用 Add-Type：
  // 它的 -ReferencedAssemblies 会对 winmd 做进程内加载校验（0x80131047 必挂），
  // 本机 5.1 又没暴露 -CompilerOptions，绕不开 → 自起 csc 最稳。
  'if (-not ("MrsTbBle.Async" -as [type])) {',
  '  $wm = Join-Path $env:Windir "System32\\WinMetadata"',
  `  $cs = @'\n${BLE_CS_HELPER}\n'@`,
  '  $csFile = Join-Path $env:TEMP "mrs-tb-ble.cs"',
  '  $dll = Join-Path $env:TEMP "mrs-tb-ble.dll"',
  '  # 带 BOM 写入：csc 无 BOM 时按本地码页读，非 ASCII 会把换行吞进多字节序列',
  '  [IO.File]::WriteAllText($csFile, $cs, (New-Object System.Text.UTF8Encoding $true))',
  '  $fw = Join-Path $env:Windir ("Microsoft.NET\\Framework" + $(if ([Environment]::Is64BitProcess) { "64" } else { "" }) + "\\v4.0.30319")',
  '  # winmd 里的类型派生自 facade 程序集里的基类型（CS0012）→ GAC 里找实际路径',
  '  $gac = Join-Path $env:Windir "Microsoft.NET\\assembly\\GAC_MSIL"',
  '  $sr = (Get-ChildItem (Join-Path $gac "System.Runtime") -Recurse -Filter "System.Runtime.dll" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName',
  '  if (-not $sr) { $sr = "System.Runtime.dll" }',
  '  $sriowr = (Get-ChildItem (Join-Path $gac "System.Runtime.InteropServices.WindowsRuntime") -Recurse -Filter "*.dll" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName',
  '  if (-not $sriowr) { $sriowr = "System.Runtime.InteropServices.WindowsRuntime.dll" }',
  '  $r = & (Join-Path $fw "csc.exe") /nologo /target:library /out:$dll /r:System.dll /r:System.Runtime.WindowsRuntime.dll ("/r:" + $sr) ("/r:" + $sriowr) ("/r:" + $wm + "\\Windows.Foundation.winmd") ("/r:" + $wm + "\\Windows.Devices.winmd") ("/r:" + $wm + "\\Windows.Storage.winmd") $csFile 2>&1',
  '  if ($LASTEXITCODE -ne 0) { Write-Output ("ERR|CSC|" + ((($r | Out-String) -replace "\r?\n", " / ").Trim())); exit 1 }',
  '  [void][System.Reflection.Assembly]::LoadFrom($dll)',
  '}',
  'function Await([object]$Op, [type]$T) { [MrsTbBle.Async]::Await($Op, $T) }',
  'function Parse-Mac([string]$s) {',
  // 兼容三种输入：XX:XX:… / XX-XX-… / 裸 12 位十六进制（本工具 ble-scan 的
  // 输出就是裸串）。旧实现按 [:-] 切分，裸串整段进 ToByte 必越界（2026-09-11
  // 真机触发：ERR|PS|值对于 UInt32 太大或太小）。
  '  $h = ($s -replace "[:-]", "").Trim()',
  '  $v = [UInt64]0',
  '  for ($i = 0; $i -lt $h.Length; $i += 2) { $v = $v * 256 + [Convert]::ToByte($h.Substring($i, 2), 16) }',
  '  $v',
  '}',
  // ---- WinRT 类型捷径（PS 5.1 的 WinRT 类型字面量写法） ----
  '$BLE_T = [Windows.Devices.Bluetooth.BluetoothLEDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]',
  '$SVCRES_T = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]',
  '$CHRRES_T = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]',
  '$COMMST_T = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]',
  '$WATCHER_T = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher,Windows.Devices.Bluetooth.Advertisement,ContentType=WindowsRuntime]',
  // 注意：GetGattServicesAsync(Uncached) 在 CH58x 上稳定 E_UNEXPECTED（2026-09-10
  // 真机实测：同一连接 Cached 无参 = Success/6 服务，Uncached 必炸）→ 全用默认 Cached
  'try {',
  '  # ---- 蓝牙无线电检查（所有模式共用） ----',
  '  $radioT = [Windows.Devices.Radios.Radio,Windows.Devices.Radios,ContentType=WindowsRuntime]',
  '  $listT = [System.Collections.Generic.IReadOnlyList`1].MakeGenericType($radioT)',
  '  $radios = Await ([Windows.Devices.Radios.Radio,Windows.Devices.Radios,ContentType=WindowsRuntime]::GetRadiosAsync()) $listT',
  '  $bt = $radios | Where-Object { $_.Kind.ToString() -eq "Bluetooth" } | Select-Object -First 1',
  '  if (-not $bt) { Write-Output "ERR|RADIO|没有蓝牙适配器"; exit 1 }',
  '  if ($bt.State.ToString() -ne "On") { Write-Output "ERR|RADIO_OFF|系统蓝牙未开启"; exit 1 }',
  '',
  '  if ($env:MRS_TB_MODE -eq "scan") {',
  '    # ---- 扫描：watcher 事件由 C# 收集进并发表（值 = 名|RSSI|可连接） ----',
  '    $watcher = $WATCHER_T::new()',
  '    [MrsTbBle.Scan]::Hook($watcher)',
  '    $watcher.ScanningMode = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode,Windows.Devices.Bluetooth.Advertisement,ContentType=WindowsRuntime]::Active',
  '    $watcher.Start()',
  '    Start-Sleep -Seconds ([int]$env:MRS_TB_DURATION)',
  '    $watcher.Stop()',
  '    $rows = @()',
  '    foreach ($k in @([MrsTbBle.Scan]::Table.Keys)) {',
  '      $v = [MrsTbBle.Scan]::Table[$k].Split([char]"|")',
  '      $rows += [pscustomobject]@{ Mac = $k; Name = $v[0]; Rssi = [int]$v[1]; Conn = $v[2] }',
  '    }',
  '    foreach ($d in ($rows | Sort-Object Rssi -Descending)) {',
  '      Write-Output ("DEV|{0}|{1}|{2}|{3}" -f $d.Mac, $d.Name, $d.Rssi, $d.Conn)',
  '    }',
  '    exit 0',
  '  }',
  '',
  '  # ---- 连接（list / session 共用） ----',
  '  $macU = Parse-Mac $env:MRS_TB_ADDR',
  '  $dev = Await ($BLE_T::FromBluetoothAddressAsync($macU)) $BLE_T',
  '  if (-not $dev) { Write-Output "ERR|ADDR|连接失败（地址不可达）"; exit 1 }',
  '  Write-Output "LOG|connected"',
  '  $svcRes = Await ($dev.GetGattServicesAsync()) $SVCRES_T',
  '  if ($svcRes.Status.ToString() -ne "Success") {',
  '    Write-Output ("ERR|GATT|" + $svcRes.Status)',
  '    $dev.Dispose(); exit 1',
  '  }',
  '  $svcList = @($svcRes.Services)',
  '  Write-Output ("LOG|services " + $svcList.Count)',
  '  function Format-Props([object]$p) {',
  '    $n = [int]$p; $s = @()',
  '    if ($n -band 0x02) { $s += "read" }',
  '    if ($n -band 0x04) { $s += "write-no-rsp" }',
  '    if ($n -band 0x08) { $s += "write" }',
  '    if ($n -band 0x10) { $s += "notify" }',
  '    if ($n -band 0x20) { $s += "indicate" }',
  '    ($s -join ",")',
  '  }',
  '  $allChars = @()',
  '  foreach ($svc in $svcList) {',
  '    $chrRes = Await ($svc.GetCharacteristicsAsync()) $CHRRES_T',
  '    Write-Output ("SVC|" + $svc.Uuid)',
  '    foreach ($c in @($chrRes.Characteristics)) {',
  '      $props = Format-Props $c.CharacteristicProperties',
  '      Write-Output ("CHR|" + $c.Uuid + "|" + $props)',
  '      $allChars += [pscustomobject]@{ Svc = $svc; C = $c; Props = $props }',
  '    }',
  '  }',
  '  if ($env:MRS_TB_MODE -eq "list") {',
  '    foreach ($svc in $svcList) { $svc.Dispose() }',
  '    $dev.Dispose(); exit 0',
  '  }',
  '',
  '  # ---- session：解析 UART 服务/特征（显式覆盖 > 三套已知配置 > 启发式） ----',
  '  $profiles = @(',
  '    @{ Svc="6e400001-b5a3-f393-e0a9-e50e24dcca9f"; Rx="6e400002-b5a3-f393-e0a9-e50e24dcca9f"; Tx="6e400003-b5a3-f393-e0a9-e50e24dcca9f"; Tag="NUS" },',
  '    @{ Svc="49535343-fe7d-4ae5-8fa9-9fafd205e455"; Rx="49535343-8841-43f4-a8d4-ec34729bb3b3"; Tx="49535343-1e4d-4bd9-ba61-23c647249616"; Tag="WCH" },',
  '    @{ Svc="0000fff0-0000-1000-8000-00805f9b34fb"; Rx="0000fff2-0000-1000-8000-00805f9b34fb"; Tx="0000fff1-0000-1000-8000-00805f9b34fb"; Tag="FFF0" }',
  '  )',
  '  $rxObj = $null; $txObj = $null; $tag = ""',
  '  if ($env:MRS_TB_SERVICE) {',
  '    $inSvc = @($allChars | Where-Object { $_.Svc.Uuid.ToString() -eq $env:MRS_TB_SERVICE })',
  '    $rxObj = $inSvc | Where-Object { $_.Props -match "write" } | Select-Object -First 1',
  '    if ($env:MRS_TB_CHAR) {',
  '      $rxObj = $inSvc | Where-Object { $_.C.Uuid.ToString() -eq $env:MRS_TB_CHAR } | Select-Object -First 1',
  '    }',
  '    $txObj = $inSvc | Where-Object { $_.Props -match "notify|indicate" } | Select-Object -First 1',
  '    $tag = "explicit"',
  '  } else {',
  '    foreach ($p in $profiles) {',
  '      $inSvc = @($allChars | Where-Object { $_.Svc.Uuid.ToString() -eq $p.Svc })',
  '      if ($inSvc.Count -gt 0) {',
  '        $rxObj = $inSvc | Where-Object { $_.C.Uuid.ToString() -eq $p.Rx } | Select-Object -First 1',
  '        $txObj = $inSvc | Where-Object { $_.C.Uuid.ToString() -eq $p.Tx } | Select-Object -First 1',
  '        if ($rxObj -and $txObj) { $tag = $p.Tag; break }',
  '      }',
  '    }',
  '    if (-not ($rxObj -and $txObj)) {',
  '      # 兜底：任一服务内同时有 可写 + 可通知 特征（含单特征收发变体）',
  '      foreach ($g in ($allChars | Group-Object { $_.Svc.Uuid.ToString() })) {',
  '        $w = $g.Group | Where-Object { $_.Props -match "write" } | Select-Object -First 1',
  '        $n = $g.Group | Where-Object { $_.Props -match "notify|indicate" } | Select-Object -First 1',
  '        if ($w -and $n) { $rxObj = $w; $txObj = $n; $tag = "guess"; break }',
  '      }',
  '    }',
  '  }',
  '  if (-not ($rxObj -and $txObj)) {',
  '    Write-Output "ERR|NO_UART|未找到可写 RX 与可通知 TX 特征"',
  '    foreach ($svc in $svcList) { $svc.Dispose() }; $dev.Dispose(); exit 1',
  '  }',
  '  Write-Output ("LOG|uart " + $tag)',
  '  # ---- 订阅 TX（notify 优先，indicate 兜底） ----',
  '  $ccc = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientCharacteristicConfigurationDescriptorValue,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]::Notify',
  '  if ($txObj.Props -notmatch "notify") {',
  '    $ccc = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientCharacteristicConfigurationDescriptorValue,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]::Indicate',
  '  }',
  '  $cccd = Await ($txObj.C.WriteClientCharacteristicConfigurationDescriptorAsync($ccc)) $COMMST_T',
  '  if ($cccd.ToString() -ne "Success") {',
  '    Write-Output ("ERR|SUB|" + $cccd)',
  '    foreach ($svc in $svcList) { $svc.Dispose() }; $dev.Dispose(); exit 1',
  '  }',
  '  Write-Output "LOG|subscribed"',
  '  [MrsTbBle.Rx]::Hook($txObj.C)',
  '  # ---- 逐行写 RX ----',
  '  if ($env:MRS_TB_SEND) {',
  '    $opt = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]::WriteWithoutResponse',
  '    if ($rxObj.Props -notmatch "write-no-rsp") {',
  '      $opt = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]::WriteWithResponse',
  '    }',
  '    foreach ($line in ($env:MRS_TB_SEND -split "`n")) {',
  '      $st = [MrsTbBle.Tx]::WriteText($rxObj.C, $line, $opt)',
  '      Write-Output ("TX|" + $line + " (" + $st + ")")',
  '      Start-Sleep -Milliseconds 50',
  '    }',
  '  }',
  '  # ---- 采集窗口：排空 C# 回调队列 ----',
  '  $end = (Get-Date).AddSeconds([int]$env:MRS_TB_DURATION)',
  '  while ((Get-Date) -lt $end) {',
  '    Start-Sleep -Milliseconds 100',
  '    $o = [MrsTbBle.Rx]::Drain()',
  '    while ($null -ne $o) { Write-Output $o; $o = [MrsTbBle.Rx]::Drain() }',
  '  }',
  '  foreach ($svc in $svcList) { $svc.Dispose() }',
  '  $dev.Dispose()',
  '  exit 0',
  '} catch {',
  '  $pos = ""; if ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber) { $pos = " @" + $_.InvocationInfo.ScriptLineNumber }',
  '  Write-Output ("ERR|PS|" + $_.Exception.Message + $pos)',
  '  exit 1',
  '}',
].join('\n');

/* ---------------- 纯函数（unit-tested） ---------------- */

export function buildBleEnv(opts: {
  mode: 'scan' | 'list' | 'session';
  addr?: string;
  durationSec?: number;
  sendLines?: string[];
  serviceUuid?: string;
  charUuid?: string;
}): Record<string, string> {
  return {
    MRS_TB_MODE: opts.mode,
    MRS_TB_ADDR: opts.addr ?? '',
    MRS_TB_DURATION: String(opts.durationSec ?? 5),
    MRS_TB_SEND: (opts.sendLines ?? []).join('\n'),
    MRS_TB_SERVICE: (opts.serviceUuid ?? '').toLowerCase(),
    MRS_TB_CHAR: (opts.charUuid ?? '').toLowerCase(),
  };
}

export function parseScanLines(text: string): BleDeviceInfo[] {
  const out: BleDeviceInfo[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.startsWith('DEV|')) { continue; }
    const parts = l.split('|');
    if (parts.length < 5 || !parts[1]) { continue; }
    out.push({
      mac: parts[1],
      name: parts[2] || '-',
      rssi: parseInt(parts[3], 10) || 0,
      connectable: parts[4] === 'yes',
    });
  }
  return out.sort((a, b) => b.rssi - a.rssi);
}

export function parseGattTable(text: string): BleServiceInfo[] {
  const services: BleServiceInfo[] = [];
  let cur: BleServiceInfo | null = null;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('SVC|')) {
      cur = { uuid: l.slice(4).trim().toLowerCase(), characteristics: [] };
      services.push(cur);
    } else if (l.startsWith('CHR|')) {
      const [uuid, props] = l.slice(4).split('|');
      if (cur && uuid) {
        cur.characteristics.push({ uuid: uuid.trim().toLowerCase(), props: (props ?? '').split(',').filter(Boolean) });
      }
    }
  }
  return services;
}

export function detectBleHint(text: string): string | undefined {
  if (/ERR\|OS/.test(text)) {
    return 'BLE 调试目前仅支持 Windows（依赖 WinRT 蓝牙栈）；Linux 可用系统 bluetoothctl 或 nRF Connect 等工具';
  }
  if (/ERR\|RADIO_OFF/.test(text)) {
    return '系统蓝牙未开启：设置 → 蓝牙和其他设备 → 打开蓝牙后重试';
  }
  if (/ERR\|RADIO\|/.test(text)) {
    return '没有蓝牙适配器：插一个支持 BLE 的 USB 蓝牙适配器后重试';
  }
  if (/ERR\|ADDR/.test(text)) {
    return '连接失败：用 `mrs-toolbox ble-scan` 重新获取地址（设备可能已停止广播）';
  }
  if (/ERR\|GATT\|Unreachable|DeviceUnreachable/.test(text)) {
    return '设备不可达：确认设备在广播，且未被其它主机连接（手机 App / BLEDebug 都会独占连接）';
  }
  if (/ERR\|GATT\|/.test(text)) {
    return 'GATT 服务枚举失败：靠近设备重试，或关掉正占用它的 BLEDebug/手机连接';
  }
  if (/ERR\|NO_UART/.test(text)) {
    return '未识别出 UART 服务：先 `ble --list` 看 GATT 表，再用 --service/--char 显式指定';
  }
  if (/ERR\|SUB/.test(text)) {
    return '订阅通知失败：该特征可能要求配对（系统设置里与设备配对）或被占用';
  }
  if (/ERR\|PS\|/.test(text)) {
    return 'WinRT 调用异常：把完整输出发给维护者排查';
  }
  return undefined;
}

/* ---------------- runner ---------------- */

async function runBlePs(
  env: Record<string, string>,
  timeoutMs: number,
  onLine?: (l: string) => void,
): Promise<{ code: number | null; output: string }> {
  // BLE 后端 = PowerShell + WinRT 投影，Windows 独有；其他平台直接给出
  // 明确错误（detectBleHint 转译），而不是让 powershell 启动失败刷屏。
  if (process.platform !== 'win32') {
    return { code: -1, output: 'ERR|OS|BLE 调试目前仅支持 Windows（WinRT 蓝牙栈）' };
  }
  // 走临时 .ps1 + -File，而不是 -Command 内联：Windows 安全中心的行为防御
  // 会拦"命令行携带本脚本这段内容"的 powershell 启动（spawn EPERM，2026-09-10
  // 实测）；-File 的命令行干净，内容侧 AMSI 正常放行。
  const file = path.join(os.tmpdir(), `mrs-toolbox-ble-${process.pid}.ps1`);
  // 必须带 BOM：无 BOM 时 powershell -File 按本地码页（GBK）读，中文注释的尾字节
  // 会把换行吞进多字节序列 → 下一行代码被并进注释静默消失（2026-09-10 整晚"玄学"
  // 报错的真因：Await 空、行号漂移、两跑结果不同，全是被吞的行不同）
  fs.writeFileSync(file, '﻿' + BLE_PS_SCRIPT, 'utf8');
  const r = await runProcess('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { env: { ...process.env, ...env }, timeoutMs, onLine });
  try { fs.unlinkSync(file); } catch { /* 临时文件，失败无妨 */ }
  return r;
}

export async function runBleScan(
  opts: BleScanOptions & { onLine?: (l: string) => void } = {},
): Promise<BleRunResult<BleDeviceInfo[]>> {
  const { onLine, ...rest } = opts;
  const duration = rest.durationSec ?? 5;
  const r = await runBlePs(buildBleEnv({ mode: 'scan', durationSec: duration }),
    (duration + 25) * 1000, onLine);
  if (r.code === 0) {
    return { ok: true, output: r.output, data: parseScanLines(r.output) };
  }
  return { ok: false, output: r.output, hint: detectBleHint(r.output) };
}

export async function runBleList(
  addr: string,
  opts: { onLine?: (l: string) => void } = {},
): Promise<BleRunResult<BleServiceInfo[]>> {
  const r = await runBlePs(buildBleEnv({ mode: 'list', addr }), 90 * 1000, opts.onLine);
  if (r.code === 0) {
    return { ok: true, output: r.output, data: parseGattTable(r.output) };
  }
  return { ok: false, output: r.output, hint: detectBleHint(r.output) };
}

export async function runBleSession(
  addr: string,
  opts: BleSessionOptions & { onLine?: (l: string) => void } = {},
): Promise<BleRunResult<void>> {
  const { onLine, ...rest } = opts;
  const duration = rest.durationSec ?? 8;
  const r = await runBlePs(
    buildBleEnv({
      mode: 'session', addr, durationSec: duration,
      sendLines: rest.sendLines, serviceUuid: rest.serviceUuid, charUuid: rest.charUuid,
    }),
    (duration + 90) * 1000, onLine);
  if (r.code === 0) {
    return { ok: true, output: r.output };
  }
  return { ok: false, output: r.output, hint: detectBleHint(r.output) };
}

/** 蓝牙适配器名（doctor 展示用）；无则 undefined。非 Windows 平台不探测。 */
export async function bleRadioName(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const r = await runProcess('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      'Get-PnpDevice -Class Bluetooth -Status OK | Where-Object { $_.FriendlyName -match "Bluetooth|蓝牙" } | ' +
      'Select-Object -First 1 | ForEach-Object { $_.FriendlyName }'],
    { timeoutMs: 15000 });
  return r.code === 0 ? r.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] : undefined;
}
