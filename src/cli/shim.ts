/**
 * cli/shim.ts — CLI 专用的 'vscode' 替身。
 *
 * 扩展核心模块（projectCreator/flasher/mrsLocator…）与 VS Code UI 解耦的关键
 * 之一：它们只用到少数 vscode API（OutputChannel / 配置读取 / workspaceFolders）。
 * CLI 以本模块为**第一个 import**，在 Module._resolveFilename 层把 'vscode'
 * 重定向到这里，随后复用的扩展代码便能在纯 node 下运行：
 *   - OutputChannel → 直接写 stdout/stderr（CLI 用户看得见烧录/编译输出）
 *   - getConfiguration → 仅返回默认值（工程级开关都在 .mrs-project.json；
 *     MRS2 路径用 --mrs 或环境变量，不需要 vscode 设置）
 * 与 test/stub/vscode 的区别：那是静默替身（单测用），这是可见替身（CLI 用）。
 */
import * as fs from 'fs';
import * as Module from 'module';
import * as path from 'path';

interface Channel {
  appendLine(line: string): void;
  append(text: string): void;
  clear(): void;
  show(): void;
  dispose(): void;
}

function consoleChannel(name: string): Channel {
  return {
    appendLine: (line) => process.stdout.write(`${line}\n`),
    append: (text) => process.stdout.write(text),
    clear: () => undefined,
    show: () => process.stdout.write(`--- ${name} ---\n`),
    dispose: () => undefined,
  };
}

const configDefaults: Record<string, unknown> = {
  'mounriverStudioPath': '',
  'examplesDirectories': [],
  // 镜像 package.json 的默认值（均空）；本机例程库用 CLI `--lib` 显式指定
  'examplesDirectory': '',
  'openocd.gdbPort': 3333,
  'openocd.telnetPort': 4444,
  'openocd.tclPort': 6666,
  'flash.verify': true,
  'flash.eraseMode': 'chip-default',
  'bleDebugPath': '',
};

const workspace = {
  workspaceFolders: [{ uri: { fsPath: process.cwd(), path: process.cwd() }, name: path.basename(process.cwd()), index: 0 }],
  getConfiguration: (_section?: string) => ({
    get: (key: string, fallback?: unknown) =>
      key in configDefaults ? configDefaults[key] : fallback,
    update: async () => undefined,
  }),
  onDidChangeConfiguration: () => ({ dispose() { /* idle */ } }),
  // vscode.workspace.fs → 原生 fs（intellisenseGen 等经它读目录/文件）
  fs: {
    async readFile(uri: unknown): Promise<Buffer> {
      return fs.promises.readFile(toFsPath(uri));
    },
    async writeFile(uri: unknown, content: Buffer | Uint8Array | string): Promise<void> {
      return fs.promises.writeFile(toFsPath(uri), content);
    },
    async readDirectory(uri: unknown): Promise<[string, number][]> {
      const dir = toFsPath(uri);
      const out: [string, number][] = [];
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
        out.push([
          e.name,
          e.isDirectory() ? 2 /* Directory */ : e.isFile() ? 1 /* File */ : 0,
        ]);
      }
      return out;
    },
    async createDirectory(uri: unknown): Promise<void> {
      await fs.promises.mkdir(toFsPath(uri), { recursive: true });
    },
    async stat(uri: unknown): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
      const s = await fs.promises.stat(toFsPath(uri));
      return {
        type: s.isDirectory() ? 2 : s.isFile() ? 1 : 0,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: s.size,
      };
    },
  },
};

/** 接受 vscode 风格 URI 或裸路径，返回文件系统路径。 */
function toFsPath(uri: unknown): string {
  if (typeof uri === 'string') {
    return uri;
  }
  const u = uri as { fsPath?: string; path?: string };
  if (u.fsPath) {
    return u.fsPath;
  }
  return decodeURIComponent(u.path ?? '').replace(/^\/([a-zA-Z]:)/, '$1');
}

const window = {
  createOutputChannel: (name: string) => consoleChannel(name),
  showInformationMessage: async (m: string) => { process.stdout.write(`${m}\n`); return undefined; },
  showWarningMessage: async (m: string) => { process.stdout.write(`${m}\n`); return undefined; },
  showErrorMessage: async (m: string) => { process.stderr.write(`${m}\n`); return undefined; },
  withProgress: async <T>(_opts: unknown, task: (p: { report(u: unknown): void }) => Promise<T>) =>
    task({ report: () => undefined }),
};

const base = {
  workspace,
  window,
  commands: { registerCommand: () => ({ dispose() { /* idle */ } }), executeCommand: async () => undefined },
  tasks: { registerTaskProvider: () => ({ dispose() { /* idle */ } }), executeTask: async () => undefined },
  extensions: { getExtension: () => undefined },
  debug: { startDebugging: async () => false },
  Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { /* marker */ },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  EventEmitter: class {
    private handlers: Array<(v: unknown) => void> = [];
    get event() {
      return (h: (v: unknown) => void) => {
        this.handlers.push(h);
        return { dispose: () => undefined };
      };
    }
    fire(v: unknown) { for (const h of this.handlers) h(v); }
    dispose() { /* idle */ }
  },
};

const shimModule = new Proxy(base, {
  get(target, prop) {
    if (prop in target) {
      return (target as Record<string | symbol, unknown>)[prop];
    }
    return undefined;
  },
});

/**
 * Install: 让 require('vscode') 直接返回本替身对象（幂等）。
 * 钩在 Module._load 而非 _resolveFilename —— esbuild 打包后 __filename 指向
 * bundle 自身，文件级重定向会循环；_load 直接给对象，与文件系统无关。
 * 必须作为 CLI 入口的第一个 import 执行。
 */
export function installVscodeShim(): void {
  // Node ≥22 的 Module._load 是只读 getter，故钩 prototype.require（普通方法，
  // 覆盖所有 require('vscode') 调用路径，含 esbuild CJS 互操作的 __require）。
  const proto = (Module as unknown as { prototype: { require: (p: string) => unknown } }).prototype;
  const orig = proto.require;
  if ((orig as unknown as { shimmed?: boolean }).shimmed) {
    return;
  }
  const hooked = function (this: unknown, request: string) {
    if (request === 'vscode') {
      return shimModule;
    }
    return orig.call(this, request);
  } as typeof orig;
  (hooked as unknown as { shimmed: boolean }).shimmed = true;
  proto.require = hooked;
}

installVscodeShim();
