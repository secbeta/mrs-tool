/**
 * args.ts — CLI 参数解析（从 cli.ts 抽出以便单测）。
 *
 * 关键约定：**multi 型旗标（可重复，如 --send / -D / --lib / --search-root）
 * 的存储键与读取键统一为去掉 -- 的短名**（send / define / lib / search-root）。
 * 此前版本直接以原始旗标名（'--send'）为键，而各命令用短名读取 →
 * `serial --send` / `create -D` / `skills --lib` 全部静默取空（TX 从未发出、
 * 宏从未生效），2026-09-10 双串口对测暴露。
 */

export interface Args {
  cmd: string;
  pos: string[];
  opt: Map<string, string>;
  multi: Map<string, string[]>;
  bool: Set<string>;
}

/** multi 型旗标：短名 → 原始写法。 */
const MULTI_FLAGS: Record<string, string[]> = {
  define: ['--define', '-D'],
  'search-root': ['--search-root'],
  lib: ['--lib'],
  send: ['--send'],
};
const MULTI_LOOKUP = new Map<string, string>(
  Object.entries(MULTI_FLAGS).flatMap(([short, forms]) => forms.map((f) => [f, short])),
);

const VALUE_FLAGS = new Set([
  '--config', '-c', '--mrs', '--mcu', '--dir', '--series', '--jobs', '-j',
  '--from-example', '--port', '--device', '--tool', '--out', '--lib',
  '--baud', '-b', '--send', '--duration', '--eol',
  // BLE（ble-scan / ble）
  '--addr', '--name', '--service', '--char',
  // multi 旗标同样"要吃一个值"，缺了会被当成布尔旗标/位置参数
  '--define', '-D', '--search-root',
]);

function normalizeOpt(a: string): string {
  return a
    .replace(/^--/, '')
    .replace(/^-c$/, 'config')
    .replace(/^-j$/, 'jobs')
    .replace(/^-D$/, 'define')
    .replace(/^-b$/, 'baud');
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: argv[0] ?? 'help', pos: [], opt: new Map(), multi: new Map(), bool: new Set() };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`flag ${a} 需要一个值`);
      }
      const multiKey = MULTI_LOOKUP.get(a);
      if (multiKey) {
        args.multi.set(multiKey, [...(args.multi.get(multiKey) ?? []), v]);
      } else {
        args.opt.set(normalizeOpt(a), v);
      }
    } else if (a.startsWith('--')) {
      args.bool.add(a.replace(/^--/, ''));
    } else {
      args.pos.push(a);
    }
  }
  return args;
}
