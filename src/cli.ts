/**
 * cli.ts — mrs-toolbox 无头 CLI（与 VS Code 扩展同一套核心代码）。
 *
 * 存在动机：扩展命令活在 VS Code UI 里（向导 / Generate Build Files / F7），
 * CLI 会话与其它 AI 助手够不着。本入口让同样的能力在纯命令行可用：
 *   mrs-toolbox doctor | gen | build | rebuild | clean | flash | erase | create | mcus
 * 与扩展共用 projectCreator / flasher / mrsLocator / makeEnv —— 不复制逻辑。
 * （工程级"给 AI 看的说明书"由 finalizeProject 写入 AGENTS.md/CLAUDE.md。）
 */
import './cli/shim'; // 必须第一个：把 require('vscode') 接到 CLI 替身
import * as fs from 'fs';
import * as path from 'path';
import { MrsInstallation } from './locator/mrsInstallation';
import { MrsLocator } from './locator/mrsLocator';
import { loadProject, type MrsProject } from './project/projectModel';
import { createProject, finalizeProject } from './project/projectCreator';
import { switchMcu, McuSwitchError } from './project/mcuSwitcher';
import { makeEnv } from './build/makeEnv';
import { flashProject, eraseChip } from './flash/flasher';
import { flashViaIsp, resolveIspTool, ispToolInstallHint, WCHISP_DOWNLOAD } from './flash/ispFlasher';
import { scanExampleLibrary } from './examples/exampleLibrary';
import { libraryDirs } from './examples/libraryManager';
import { writeExampleSkills } from './gen/skillGen';
import { listSerialPorts } from './serial/serialPorts';
import { runSerialSession } from './serial/serialConsole';
import { runBleScan, runBleList, runBleSession, bleRadioName } from './ble/bleConsole';
import { runProcess } from './util/proc';
import { parseArgs, type Args } from './cli/args';

const VERSION: string = require('../package.json').version;

function die(msg: string, hint?: string): never {
  process.stderr.write(`mrs-toolbox: ${msg}\n`);
  if (hint) { process.stderr.write(`  提示: ${hint}\n`); }
  process.exit(1);
}

function ok(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/* ---------------- 环境定位 ---------------- */

async function resolveInst(args: Args): Promise<MrsInstallation> {
  const explicit = args.opt.get('mrs');
  const roots = explicit ? [explicit] : await new MrsLocator(undefined as never).detect();
  for (const root of roots) {
    const inst = await MrsInstallation.load(root);
    if (inst instanceof MrsInstallation) {
      return inst;
    }
  }
  die('未找到 MounRiver Studio 2 安装', explicit ? `检查路径 ${explicit}` : '用 --mrs <安装根目录> 指定，或安装 MRS2');
}

/** 从起始目录向上找 .mrs-project.json（最多 6 层）；找不到返回 undefined。 */
function findProjectDir(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, '.mrs-project.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return undefined;
}

/** 从参数目录或 cwd 向上找 .mrs-project.json（最多 6 层）。 */
function resolveProjectDir(args: Args): string {
  const dir = findProjectDir(path.resolve(args.pos[0] ?? '.'));
  if (dir) {
    return dir;
  }
  die(`在 ${path.resolve(args.pos[0] ?? '.')} 及其上级未找到 .mrs-project.json`, '进入工程目录再运行，或传工程目录参数');
}

async function loadProjOrDie(dir: string): Promise<{ proj: MrsProject; dir: string }> {
  const proj = await loadProject(dir);
  if (!proj) { die(`无法解析 ${path.join(dir, '.mrs-project.json')}（字段缺失或非法）`); }
  return { proj, dir };
}

/* ---------------- 子命令 ---------------- */

async function cmdDoctor(args: Args): Promise<number> {
  const inst = await resolveInst(args);
  const riscv = inst.chipDb.series.filter((s) => s.type === 'RISC-V').length;
  const arm = inst.chipDb.series.filter((s) => s.type === 'ARM').length;
  const mcus = inst.chipDb.series.reduce((n, s) => n + s.mcus.length, 0);
  ok(`MounRiver Studio 2 @ ${inst.root}`);
  ok(`toolchains : ${inst.toolchains.names.join(', ')}`);
  ok(`chip db    : ${riscv} RISC-V + ${arm} ARM 系列 / ${mcus} MCU`);
  ok(`make       : ${inst.makeExe}`);
  ok(`openocd    : ${inst.openocdExe}`);
  const ispTool = await resolveIspTool(args.opt.get('tool'), inst);
  ok(`isp(wchisp): ${ispTool ?? `未安装 — ISP 直连烧录不可用（下载 ${WCHISP_DOWNLOAD}）`}`);
  const radio = await bleRadioName();
  ok(`ble(radio) : ${radio ?? '未检测到 — BLE 调试不可用（插 USB 蓝牙适配器并开启蓝牙）'}`);
  // doctor 允许无工程环境纯检查（resolveProjectDir 会 process.exit，故走 findProjectDir）
  const dir = findProjectDir(path.resolve(args.pos[0] ?? '.'));
  if (dir) {
    const { proj } = await loadProjOrDie(dir);
    const tc = inst.toolchains.resolve(proj.mcu.toolchainName);
    ok(`project    : ${proj.mcu.mcuId} (${proj.mcu.toolchainName}${tc ? '' : ' — 工具链缺失!'}) @ ${dir}`);
  }
  return 0;
}

async function cmdGen(args: Args): Promise<number> {
  const dir = resolveProjectDir(args);
  const inst = await resolveInst(args);
  const { proj } = await loadProjOrDie(dir);
  await finalizeProject(inst, dir, proj);
  ok(`已重新生成 Makefile / .cproject / IntelliSense / AGENTS.md @ ${dir}`);
  return 0;
}

async function runMake(inst: MrsInstallation, dir: string, proj: MrsProject, targets: string[], args: Args): Promise<number> {
  const cfg = args.opt.get('config') ?? 'release';
  if (cfg !== 'debug' && cfg !== 'release') { die(`--config 只接受 debug|release，收到 ${cfg}`); }
  const jobs = args.opt.get('jobs') ?? String(require('os').cpus().length ?? 4);
  const argv = ['-j' + jobs, 'CONFIG=' + cfg, ...targets];
  ok(`> make ${argv.join(' ')}   (cwd: ${dir})`);
  const r = await runProcess(inst.makeExe, argv, {
    cwd: dir,
    env: makeEnv(inst, proj),
    onLine: (l) => process.stdout.write(`${l}\n`),
  });
  return r.code === 0 ? 0 : (r.code ?? 1);
}

async function cmdBuild(args: Args, targets: string[]): Promise<number> {
  const dir = resolveProjectDir(args);
  const inst = await resolveInst(args);
  const { proj } = await loadProjOrDie(dir);
  const code = await runMake(inst, dir, proj, targets, args);
  if (code === 0) {
    ok(`== BUILD OK (${path.join(dir, 'obj')}) ==`);
  } else {
    ok(`== BUILD FAILED (exit ${code}) ==`);
  }
  return code;
}

async function cmdFlash(args: Args): Promise<number> {
  const dir = resolveProjectDir(args);
  const inst = await resolveInst(args);
  const { proj } = await loadProjOrDie(dir);
  const r = await flashProject(inst, proj, dir);
  return r.ok ? 0 : 1;
}

async function cmdErase(args: Args): Promise<number> {
  const dir = resolveProjectDir(args);
  const inst = await resolveInst(args);
  const { proj } = await loadProjOrDie(dir);
  const r = await eraseChip(inst, proj, dir);
  return r.ok ? 0 : 1;
}

async function cmdIsp(args: Args): Promise<number> {
  const dir = resolveProjectDir(args);
  const inst = await resolveInst(args);
  const { proj } = await loadProjOrDie(dir);
  const tool = await resolveIspTool(args.opt.get('tool'), inst);
  if (!tool) {
    die('未找到 wchisp（ISP 烧录，扩展不捆绑二进制）',
      `下载 ${WCHISP_DOWNLOAD}；放到 PATH 或本命令 --tool 指定。\n  ${ispToolInstallHint(inst).split('\n').slice(1).join('\n  ')}`);
  }
  const dev = args.opt.get('device');
  const r = await flashViaIsp(inst, proj, dir, {
    serialPort: args.opt.get('port'),
    deviceIndex: dev !== undefined ? parseInt(dev, 10) : undefined,
    toolPath: tool,
  });
  return r.ok ? 0 : 1;
}

async function cmdCreate(args: Args): Promise<number> {
  const inst = await resolveInst(args);
  const mcuId = args.opt.get('mcu');
  const dest = args.opt.get('dir');
  if (!mcuId || !dest) { die('create 需要 --mcu <ID> 与 --dir <目标目录>', '可用 MCU 见 `mrs-toolbox mcus`'); }
  const series = inst.chipDb.series.find((s) => s.mcus.some((m) => m.id.toLowerCase() === mcuId.toLowerCase()));
  if (!series) { die(`未找到 MCU ${mcuId}`, '先 `mrs-toolbox mcus` 查看可用型号'); }
  const exampleDir = args.opt.get('from-example');
  const proj = await createProject(inst, {
    series,
    mcuId: series.mcus.find((m) => m.id.toLowerCase() === mcuId.toLowerCase())!.id,
    destDir: path.resolve(dest),
    createdFrom: exampleDir ? 'example' : 'template',
    exampleDir: exampleDir ? path.resolve(exampleDir) : undefined,
    extraDefines: args.multi.get('define'),
    searchRoots: args.multi.get('search-root')?.map((p) => path.resolve(p)),
  });
  ok(`已创建工程: ${path.resolve(dest)} (MCU ${proj.mcu.mcuId}, ${exampleDir ? 'from example' : 'from template'})`);
  ok('下一步: mrs-toolbox build ' + path.resolve(dest));
  return 0;
}

async function cmdMcus(args: Args): Promise<number> {
  const inst = await resolveInst(args);
  const want = args.opt.get('series')?.toLowerCase();
  for (const s of inst.chipDb.series) {
    if (want && s.name.toLowerCase() !== want) { continue; }
    ok(`${s.name} (${s.type}, ${s.toolchain.name}): ${s.mcus.map((m) => m.id).join(' ')}`);
  }
  return 0;
}

async function cmdSwitchMcu(args: Args): Promise<number> {
  const mcu = args.opt.get('mcu');
  if (!mcu) { die('switch-mcu 需要 --mcu <ID>', '同系列可用型号见 `mrs-toolbox mcus`'); }
  const dir = resolveProjectDir(args);
  const inst = await resolveInst(args);
  const { proj } = await loadProjOrDie(dir);
  let r;
  try {
    r = await switchMcu(inst, dir, proj, mcu);
  } catch (e) {
    if (e instanceof McuSwitchError) { die(e.message); }
    throw e;
  }
  ok(`已切换 ${r.fromMcuId} → ${r.toMcuId} (${dir})`);
  for (const f of r.updated) { ok(`  更新: ${f}`); }
  for (const f of r.removed) { ok(`  移除: ${f}`); }
  for (const f of r.conflicts) { ok(`  保留(你改过): ${f}`); }
  for (const n of r.notes) { ok(`  ${n}`); }
  return 0;
}

async function cmdSkills(args: Args): Promise<number> {
  const explicit = args.multi.get('lib') ?? [];
  const roots = (explicit.length ? explicit : libraryDirs()).map((p) => path.resolve(p));
  if (!roots.length) {
    die('没有可用的例程库', '用 --lib <例程库目录> 指定（可多个），或在 VS Code 设置 mrsToolbox.examplesDirectories 里配置');
  }
  const outDir = path.resolve(args.opt.get('out') ?? path.join(require('os').homedir(), '.claude', 'skills'));
  const libs = roots.map(scanExampleLibrary).filter((l) => l.examples.length > 0);
  if (!libs.length) {
    die('例程库中未识别到任何例程', '检查目录布局：<库>/<芯片>/[EVT/]EXAM/<分类>/<例程>');
  }
  const r = await writeExampleSkills(libs, outDir, VERSION);
  const total = libs.reduce((n, l) => n + l.examples.length, 0);
  ok(`已生成 ${libs.length} 库 / ${total} 例程的 AI skills → ${outDir}`);
  for (const f of [...r.written, ...r.kept]) { ok(`  skill: ${f}`); }
  for (const f of r.removed) { ok(`  清理陈旧: ${f}`); }
  for (const f of r.skippedEdited) { ok(`  保留(手改过): ${f}`); }
  return 0;
}

async function cmdPorts(): Promise<number> {
  const ports = await listSerialPorts();
  if (!ports.length) {
    ok('（未发现串口）');
    return 0;
  }
  for (const p of ports) {
    ok(`${p.isWch ? '*' : ' '} ${p.port.padEnd(6)} ${p.name}${p.isWch ? '  [WCH]' : ''}`);
  }
  ok('* = WCH 适配器（CH340/CH343/WCH-Link 虚拟串口）排最前');
  return 0;
}

async function cmdSerial(args: Args): Promise<number> {
  let port = args.opt.get('port');
  if (!port) {
    const ports = await listSerialPorts();
    if (ports.length === 1) {
      port = ports[0].port;
      ok(`（唯一串口，自动选用 ${port} — ${ports[0].name}）`);
    } else if (ports.length === 0) {
      die('未发现串口', '插好板子后 `mrs-toolbox ports` 查看');
    } else {
      die('有多个串口，需要 --port 指定', '候选：\n  ' + ports.map((p) => `${p.port} ${p.name}`).join('\n  '));
    }
  }
  const eol = args.opt.get('eol') ?? 'crlf';
  if (eol !== 'crlf' && eol !== 'lf') { die(`--eol 只接受 crlf|lf，收到 ${eol}`); }
  const r = await runSerialSession(port, {
    baud: parseInt(args.opt.get('baud') ?? '115200', 10),
    sendLines: args.multi.get('send'),
    durationSec: parseFloat(args.opt.get('duration') ?? '3'),
    eol,
    onLine: (l) => process.stdout.write(`${l}\n`),
  });
  if (r.ok) { return 0; }
  process.stderr.write(r.output.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') + '\n');
  die(`串口会话失败 (${port})`, r.hint);
}

/* ---------------- BLE ---------------- */

async function cmdBleScan(args: Args): Promise<number> {
  const filter = args.opt.get('name');
  const r = await runBleScan({ durationSec: parseFloat(args.opt.get('duration') ?? '5') });
  if (!r.ok) {
    process.stderr.write(r.output.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') + '\n');
    die('BLE 扫描失败', r.hint);
  }
  const devs = (r.data ?? []).filter((d) => !filter || d.name.toLowerCase().includes(filter.toLowerCase()));
  for (const d of devs) {
    ok(`${d.connectable ? '*' : ' '} ${d.mac}  ${String(d.rssi).padStart(4)} dBm  ${d.name}`);
  }
  ok(`* = 可连接（Connectable 广播）；共 ${devs.length} 台${filter ? `（过滤: ${filter}）` : ''}`);
  return 0;
}

/** 从 --addr 或 --name（扫描解析，要求唯一匹配）得到目标 MAC。 */
async function resolveBleAddr(args: Args): Promise<string> {
  const addr = args.opt.get('addr');
  if (addr) { return addr; }
  const name = args.opt.get('name')!;
  ok(`（按广播名 ${name} 扫描解析地址，约 8 秒…）`);
  const r = await runBleScan({ durationSec: 8 });
  if (!r.ok) {
    process.stderr.write(r.output.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') + '\n');
    die('BLE 扫描失败', r.hint);
  }
  const hits = (r.data ?? []).filter((d) => d.name.toLowerCase().includes(name.toLowerCase()));
  if (hits.length === 0) {
    die(`没扫描到广播名含 "${name}" 的设备`, '用 mrs-toolbox ble-scan 查看周围设备；设备可能未在广播');
  }
  if (hits.length > 1) {
    die(`广播名 "${name}" 匹配到 ${hits.length} 台，无法确定目标`, '候选：\n  ' + hits.map((d) => `${d.mac} ${d.name}`).join('\n  ') + '\n  用 --addr 精确指定');
  }
  ok(`（唯一匹配 ${hits[0].mac} — ${hits[0].name}）`);
  return hits[0].mac;
}

async function cmdBle(args: Args): Promise<number> {
  if (!args.opt.get('addr') && !args.opt.get('name')) {
    die('ble 需要 --addr <MAC> 或 --name <广播名>', '先用 mrs-toolbox ble-scan 找设备');
  }
  const addr = await resolveBleAddr(args);
  const listMode = args.bool.has('list');
  const print = (l: string) => process.stdout.write(`${l}\n`);
  if (listMode) {
    const r = await runBleList(addr, { onLine: (l) => { if (l.startsWith('LOG|')) { print(l); } } });
    if (!r.ok) {
      process.stderr.write(r.output.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') + '\n');
      die(`BLE GATT 列表失败 (${addr})`, r.hint);
    }
    for (const s of r.data ?? []) {
      ok(`服务 ${s.uuid}`);
      for (const c of s.characteristics) {
        ok(`  特征 ${c.uuid}  [${c.props.join(',') || '?'}]`);
      }
    }
    return 0;
  }
  const r = await runBleSession(addr, {
    sendLines: args.multi.get('send'),
    durationSec: parseFloat(args.opt.get('duration') ?? '8'),
    serviceUuid: args.opt.get('service'),
    charUuid: args.opt.get('char'),
    onLine: print,
  });
  if (r.ok) { return 0; }
  process.stderr.write(r.output.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') + '\n');
  die(`BLE 会话失败 (${addr})`, r.hint);
}

/* ---------------- main ---------------- */

const HELP = `mrs-toolbox v${VERSION} — WCH 工具链无头 CLI（与 VS Code 扩展同源）

用法:
  mrs-toolbox doctor [dir]                    检查 MRS2 / 工具链 / 工程
  mrs-toolbox gen [dir]                       重新生成 Makefile/.cproject/IntelliSense/AGENTS.md
  mrs-toolbox build [dir] [-c debug|release] [-j N]   编译（默认 release）
  mrs-toolbox rebuild [dir] / clean [dir]     重建 / 清理
  mrs-toolbox flash [dir]                     WCH-Link 烧录（RISC-V/ARM 自适应）
  mrs-toolbox isp [dir] [--port COMx] [--device N] [--tool <wchisp>]
                                              ISP 直连烧录（USB/串口 Bootloader，无需
                                              WCH-Link；需 wchisp，doctor 可查）
  mrs-toolbox erase [dir]                     全片擦除
  mrs-toolbox create --mcu <ID> --dir <路径> [--from-example <例程目录>] [-D K=V]...
  mrs-toolbox switch-mcu [dir] --mcu <ID>     同系列切换型号（CH582F→CH582M）
  mrs-toolbox mcus [--series <名>]            列出可用系列与 MCU
  mrs-toolbox skills [--lib <库>]... [--out <目录>]
                                              生成例程库 AI skills（默认 ~/.claude/skills，
                                              每库一个 SKILL.md；例程增删后重跑即同步）
  mrs-toolbox ports                           列出 COM 口与适配器（WCH 优先）
  mrs-toolbox serial [--port COMx] [-b 115200] [--send 行]... [--duration 3] [--eol crlf|lf]
                                              打开串口→发送→采集→关闭（AI 调试单片机用；
                                              唯一串口时免 --port）
  mrs-toolbox ble-scan [--duration 5] [--name 过滤]
                                              扫描 BLE 广播设备（名/MAC/RSSI，需电脑蓝牙）
  mrs-toolbox ble (--addr MAC|--name 名) [--list] [--service U] [--char U]
                  [--send 行]... [--duration 8]            BLE 连接调试：--list=GATT 表；
                                              默认 UART 会话（自动识别 NUS/WCH/FFF0 透传，
                                              写→订阅通知→采集；需电脑蓝牙）
  mrs-toolbox version / help

全局: --mrs <MRS2安装根>（默认自动探测）
目录: 所有 [dir] 可省略 = 从 cwd 向上找 .mrs-project.json`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let args: Args;
  try {
    args = parseArgs(argv.length ? argv : ['help']);
  } catch (e) {
    die(String((e as Error).message));
  }
  switch (args.cmd) {
    case 'doctor': return cmdDoctor(args);
    case 'gen': return cmdGen(args);
    case 'build': return cmdBuild(args, []);
    case 'rebuild': return cmdBuild(args, ['rebuild']);
    case 'clean': return cmdBuild(args, ['clean']);
    case 'flash': return cmdFlash(args);
    case 'isp': return cmdIsp(args);
    case 'erase': return cmdErase(args);
    case 'create': return cmdCreate(args);
    case 'switch-mcu': return cmdSwitchMcu(args);
    case 'mcus': return cmdMcus(args);
    case 'skills': return cmdSkills(args);
    case 'ports': return cmdPorts();
    case 'serial': return cmdSerial(args);
    case 'ble-scan': return cmdBleScan(args);
    case 'ble': return cmdBle(args);
    case 'version': ok(`mrs-toolbox v${VERSION}`); return 0;
    case 'help': case '--help': case '-h': ok(HELP); return 0;
    default: die(`未知命令 ${args.cmd}`, '运行 mrs-toolbox help 查看用法');
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`mrs-toolbox: ${e?.stack ?? String(e)}\n`);
    process.exit(1);
  },
);
