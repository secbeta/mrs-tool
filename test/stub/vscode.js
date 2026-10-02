'use strict';
/**
 * Minimal 'vscode' module stub for running extension code under plain node
 * (unit tests / e2e verification). Only the APIs the non-UI code paths use
 * are implemented; everything else is a silent no-op via Proxy.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function toFsPath(uri) {
  // Accept vscode-style file URIs or raw paths.
  if (typeof uri === 'string') {
    return uri;
  }
  return uri.fsPath ?? decodeURIComponent(uri.path.replace(/^\/([a-zA-Z]:)/, '$1'));
}

const workspace = {
  workspaceFolders: undefined,
  fs: {
    async readDirectory(uri) {
      const dir = toFsPath(uri);
      const out = [];
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        out.push([
          e.name,
          e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : FileType.Unknown,
        ]);
      }
      return out;
    },
    readFile(uri) {
      return fsp.readFile(toFsPath(uri));
    },
  },
  getConfiguration() {
    return {
      get: (key, fallback) => fallback,
      update: async () => undefined,
    };
  },
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
};

const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
};

const commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined };
const tasks = {
  registerTaskProvider: () => ({ dispose() {} }),
  executeTask: async () => undefined,
  onDidEndTaskProcess: () => ({ dispose() {} }),
};
const extensions = { getExtension: () => undefined };
const debug = { startDebugging: async () => false };

function stub(name) {
  switch (name) {
    case 'workspace': return workspace;
    case 'window': return window;
    case 'commands': return commands;
    case 'tasks': return tasks;
    case 'extensions': return extensions;
    case 'debug': return debug;
    case 'FileType': return FileType;
    default: return undefined;
  }
}

const base = {
  workspace,
  window,
  commands,
  tasks,
  extensions,
  debug,
  FileType,
  Uri: { file: (p) => ({ fsPath: p, path: p }) },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ProgressLocation: { Notification: 15 },
  EventEmitter: class {
    constructor() { this.handlers = []; }
    get event() { return (h) => { this.handlers.push(h); return { dispose: () => {} }; }; }
    fire(v) { for (const h of this.handlers) h(v); }
    dispose() {}
  },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
};

module.exports = new Proxy(base, {
  get(target, prop) {
    if (prop in target) {
      return target[prop];
    }
    return stub(prop);
  },
});

/** Install the stub so `require('vscode')` resolves here (idempotent). */
module.exports.install = function install() {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') {
      return __filename;
    }
    return origResolve.call(this, request, parent, isMain, options);
  };
};

module.exports.paths = { join: path.join };
module.exports.existsSyncFn = fs.existsSync;
