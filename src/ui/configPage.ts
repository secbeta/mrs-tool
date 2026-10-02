import * as vscode from 'vscode';
import type { ToolboxContext } from '../toolbox';
import { MrsInstallation } from '../locator/mrsInstallation';
import {
  libraryExists,
  libraryLabel,
  removeLibraryDir,
  scanAllLibraries,
} from '../examples/libraryManager';
import { runAddExamplesLibrary } from '../commands/examples';
import { pickMounriverRoot } from '../project/wizard';

/**
 * ESP-IDF-style graphical configuration page (webview):
 *  - MounRiver Studio 2 install: current status, detected candidates, browse
 *    (toolchain paths are auto-derived from the chosen root and shown inline)
 *  - Example libraries: list + add/remove (like installing extra ADF libs)
 *  - Common flash/debug settings
 */
export interface ConfigPageState {
  version: string;
  install: {
    setting: string;
    root?: string;
    error?: string;
    summaryLines: string[];
    candidates: { root: string; valid: boolean; active: boolean; error?: string }[];
  };
  libs: { dir: string; label: string; exists: boolean; count: number; chips: string[] }[];
  settings: {
    provider: string;
    verify: boolean;
    eraseMode: string;
    gdbPort: number;
    telnetPort: number;
    tclPort: number;
  };
  active?: { name: string; mcuId: string; series: string; toolchain: string; config: string };
}

const SETTING_MAP: Record<string, [string, 'string' | 'boolean' | 'number']> = {
  provider: ['mrsToolbox.debug.provider', 'string'],
  verify: ['mrsToolbox.flash.verify', 'boolean'],
  eraseMode: ['mrsToolbox.flash.eraseMode', 'string'],
  gdbPort: ['mrsToolbox.openocd.gdbPort', 'number'],
  telnetPort: ['mrsToolbox.openocd.telnetPort', 'number'],
  tclPort: ['mrsToolbox.openocd.tclPort', 'number'],
};

export class ConfigPage {
  static readonly viewType = 'mrsToolbox.configPage';
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly tbx: ToolboxContext) {}

  register(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.commands.registerCommand('mrsToolbox.configure', () => this.show()),
      vscode.window.registerWebviewPanelSerializer(ConfigPage.viewType, {
        deserializeWebviewPanel: (panel) => {
          this.attach(panel);
          return Promise.resolve();
        },
      }),
    );
    context.subscriptions.push(...this.disposables);
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      void this.postState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ConfigPage.viewType,
      'MRS Toolbox 配置',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.attach(panel);
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), undefined, this.disposables);
    panel.onDidDispose(
      () => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
      },
      undefined,
      this.disposables,
    );
    void this.postState();
  }

  // ---------------------------------------------------------------- host side

  private async onMessage(m: { t: string } & Record<string, unknown>): Promise<void> {
    if (!m || typeof m !== 'object') {
      return;
    }
    switch (m.t) {
      case 'ready':
        await this.postState();
        break;
      case 'detect':
        await this.postState();
        break;
      case 'browseInstall': {
        const root = await pickMounriverRoot(this.tbx.installation?.root);
        if (root) {
          await this.applyRoot(root);
        }
        break;
      }
      case 'useRoot':
        if (typeof m.root === 'string' && m.root) {
          await this.applyRoot(m.root);
        }
        break;
      case 'autoDetect':
        await vscode.workspace
          .getConfiguration('mrsToolbox')
          .update('mounriverStudioPath', '', vscode.ConfigurationTarget.Global);
        await this.tbx.ensureInstallation(true);
        await this.postState();
        break;
      case 'runSetup':
        await vscode.commands.executeCommand('mrsToolbox.setup');
        await this.postState();
        break;
      case 'addLib':
        await runAddExamplesLibrary();
        await this.postState();
        break;
      case 'removeLib':
        if (typeof m.dir === 'string' && m.dir) {
          await removeLibraryDir(m.dir);
          void vscode.commands.executeCommand('mrsToolbox.refreshExamples');
          await this.postState();
        }
        break;
      case 'openLib':
        if (typeof m.dir === 'string' && m.dir) {
          void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(m.dir));
        }
        break;
      case 'set':
        await this.applySetting(String(m.key), m.value);
        await this.postState();
        break;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mrs-toolbox.mrs-toolbox');
        break;
    }
  }

  /** Validate a chosen install root, persist it, refresh everything. */
  private async applyRoot(root: string): Promise<void> {
    const loaded = await this.tbx.locator.loadFrom(root);
    if (loaded instanceof MrsInstallation) {
      await vscode.workspace
        .getConfiguration('mrsToolbox')
        .update('mounriverStudioPath', root, vscode.ConfigurationTarget.Global);
      // ensureInstallation picks the setting-root first now.
      await this.tbx.ensureInstallation(true);
    }
    await this.postState();
  }

  private async applySetting(key: string, value: unknown): Promise<void> {
    const entry = SETTING_MAP[key];
    if (!entry) {
      return;
    }
    const [id, kind] = entry;
    const coerced =
      kind === 'boolean'
        ? !!value
        : kind === 'number'
          ? Number(value)
          : String(value);
    await vscode.workspace
      .getConfiguration()
      .update(id, coerced, vscode.ConfigurationTarget.Global);
  }

  private async buildState(): Promise<ConfigPageState> {
    const cfg = vscode.workspace.getConfiguration('mrsToolbox');
    const setting = cfg.get<string>('mounriverStudioPath', '');

    const candidates: ConfigPageState['install']['candidates'] = [];
    let rootInst = this.tbx.installation;
    for (const root of await this.tbx.locator.detect()) {
      const loaded = await this.tbx.locator.loadFrom(root);
      const valid = loaded instanceof MrsInstallation;
      candidates.push({
        root,
        valid,
        active: valid && (rootInst ? rootInst.root.toLowerCase() === root.toLowerCase() : false),
        error: valid ? undefined : (loaded as { error: string }).error,
      });
    }
    if (!rootInst) {
      // Resolve the winner for display without the require() error popup.
      for (const root of await this.tbx.locator.detect()) {
        const loaded = await this.tbx.locator.loadFrom(root);
        if (loaded instanceof MrsInstallation) {
          rootInst = loaded;
          for (const c of candidates) {
            if (c.root.toLowerCase() === root.toLowerCase()) {
              c.active = true;
            }
          }
          break;
        }
      }
    }

    const summaryLines = rootInst ? rootInst.summary.split('\n').slice(1) : [];
    const install: ConfigPageState['install'] = {
      setting,
      root: rootInst?.root,
      error: rootInst ? undefined : '未找到可用的 MounRiver Studio 2 安装',
      summaryLines,
      candidates,
    };

    const libs = scanAllLibraries().map((l) => ({
      dir: l.root,
      label: libraryLabel(l.root),
      exists: libraryExists(l.root),
      count: l.examples.length,
      chips: [...new Set(l.examples.map((e) => e.chipFolder))],
    }));

    const active = await this.tbx.activeProject();
    return {
      version: String(this.tbx.ext.extension.packageJSON?.version ?? ''),
      install,
      libs,
      settings: {
        provider: cfg.get<string>('debug.provider', 'auto'),
        verify: cfg.get<boolean>('flash.verify', true),
        eraseMode: cfg.get<string>('flash.eraseMode', 'chip-default'),
        gdbPort: cfg.get<number>('openocd.gdbPort', 3333),
        telnetPort: cfg.get<number>('openocd.telnetPort', 4444),
        tclPort: cfg.get<number>('openocd.tclPort', 6666),
      },
      active: active
        ? {
            name: active.proj.build.targetName,
            mcuId: active.proj.mcu.mcuId,
            series: active.proj.mcu.series,
            toolchain: active.proj.mcu.toolchainName,
            config: this.tbx.buildConfig,
          }
        : undefined,
    };
  }

  private async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      const state = await this.buildState();
      await this.panel.webview.postMessage({ t: 'state', state });
    } catch (e) {
      void vscode.window.showErrorMessage(`MRS Toolbox 配置页刷新失败: ${String(e)}`);
    }
  }

  // ---------------------------------------------------------------- page side

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 8px 32px 48px;
    max-width: 860px;
    margin: 0 auto;
  }
  header { display: flex; align-items: center; gap: 12px; padding: 20px 0 4px; }
  header .logo { width: 36px; height: 36px; color: var(--vscode-textLink-foreground); flex: none; }
  header h1 { font-size: 20px; font-weight: 600; margin: 0; }
  header .ver {
    font-size: 11px; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 8px;
  }
  header .spacer { flex: 1; }
  .section { margin-top: 30px; }
  .section > h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; margin: 0;
  }
  .card {
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    padding: 12px 14px; margin-top: 12px;
    background: var(--vscode-sideBar-background, transparent);
  }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .row + .row { margin-top: 8px; }
  .grow { flex: 1; min-width: 0; }
  .path {
    font-family: var(--vscode-editor-font-family); font-size: 12px;
    color: var(--vscode-textLink-foreground);
    overflow-wrap: anywhere;
  }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .ok { color: var(--vscode-testing-iconPassed, #73c991); font-weight: 600; }
  .err { color: var(--vscode-testing-iconFailed, #f14c4c); font-weight: 600; }
  .btn {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 2px; padding: 5px 14px; cursor: pointer;
    font-family: inherit; font-size: 13px; white-space: nowrap;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
  .btn.small { padding: 2px 10px; font-size: 12px; }
  .detail-list { margin: 10px 0 0; padding: 0; list-style: none; }
  .detail-list li { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 2px 0; }
  .detail-list li b { color: var(--vscode-foreground); font-weight: 600; }
  .candidate { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--vscode-panel-border); }
  .candidate:first-of-type { border-top: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: var(--vscode-testing-iconPassed, #73c991); }
  .dot.err { background: var(--vscode-testing-iconFailed, #f14c4c); }
  .badge {
    font-size: 11px; border-radius: 8px; padding: 0 8px;
    border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground);
  }
  select, input[type="number"] {
    font-family: inherit; font-size: 13px; color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; padding: 3px 6px;
  }
  input[type="number"] { width: 90px; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .setting-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
  .setting-row:first-of-type { border-top: none; }
  .setting-row label.main { flex: 1; }
  .setting-row label.main .muted { display: block; }
  .kv { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .kv b { color: var(--vscode-foreground); }
  .icon-btn { display: inline-flex; align-items: center; }
  .icon-btn svg { display: block; }
</style>
</head>
<body>
<header>
  <span class="logo">${iconChip()}</span>
  <h1>MRS Toolbox</h1>
  <span class="ver" id="ver"></span>
  <span class="spacer"></span>
  <button class="btn secondary" data-act="openSettings">所有设置…</button>
  <button class="btn secondary" data-act="runSetup">运行 Setup</button>
</header>

<div class="section">
  <h2>MounRiver Studio 2 安装</h2>
  <div id="install-section" class="card"></div>
</div>

<div class="section">
  <h2>例程库（可添加多个）</h2>
  <div id="libs-section" class="card"></div>
</div>

<div class="section">
  <h2>常用设置</h2>
  <div id="settings-section" class="card"></div>
</div>

<div class="section" id="project-section-wrap" style="display:none">
  <h2>当前工程</h2>
  <div id="project-section" class="card"></div>
</div>

<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function render(s) {
    document.getElementById('ver').textContent = s.version ? 'v' + s.version : '';
    renderInstall(s.install);
    renderLibs(s.libs);
    renderSettings(s.settings);
    renderProject(s.active);
  }

  function renderInstall(inst) {
    var el = document.getElementById('install-section');
    var html = '';
    if (inst.root) {
      html += '<div class="row"><span class="ok">&#10003; 已配置</span>'
        + '<span class="path grow">' + esc(inst.root) + '</span>'
        + '<button class="btn secondary small" data-act="browseInstall">浏览…</button>'
        + '<button class="btn secondary small" data-act="autoDetect">改回自动探测</button>'
        + '</div><ul class="detail-list">'
        + inst.summaryLines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('')
        + '</ul>';
    } else {
      html += '<div class="row"><span class="err">&#9888; 未找到安装</span>'
        + '<span class="muted grow">工具链 / 芯片库 / openocd 均来自 MRS2 安装，请选择其安装目录</span>'
        + '<button class="btn small" data-act="browseInstall">浏览…</button>'
        + '</div>';
    }
    if (inst.candidates.length > 0) {
      html += '<div style="margin-top:12px" class="muted">本机探测到的安装：</div>';
      for (var i = 0; i < inst.candidates.length; i++) {
        var c = inst.candidates[i];
        html += '<div class="candidate"><span class="dot ' + (c.valid ? 'ok' : 'err') + '"></span>'
          + '<span class="path grow">' + esc(c.root) + '</span>'
          + (c.active ? '<span class="badge">当前使用</span>' : '')
          + (c.valid
            ? (c.active ? '' : '<button class="btn secondary small" data-act="useRoot" data-root="' + esc(c.root) + '">使用</button>')
            : '<span class="muted">' + esc(c.error || '无效') + '</span>')
          + '</div>';
      }
    }
    el.innerHTML = html;
  }

  function renderLibs(libs) {
    var el = document.getElementById('libs-section');
    var html = '';
    for (var i = 0; i < libs.length; i++) {
      var l = libs[i];
      html += '<div class="row"><b>' + esc(l.label) + '</b>'
        + '<span class="path grow">' + esc(l.dir) + '</span>'
        + (l.exists
          ? '<span class="muted">' + l.count + ' 例程 · ' + l.chips.length + ' 芯片</span>'
          : '<span class="err">目录不存在</span>')
        + '<button class="btn secondary small" data-act="openLib" data-dir="' + esc(l.dir) + '">打开</button>'
        + '<button class="btn secondary small" data-act="removeLib" data-dir="' + esc(l.dir) + '">移除</button>'
        + '</div>';
      if (l.exists && l.chips.length > 0) {
        html += '<div class="muted" style="margin:2px 0 10px">' + esc(l.chips.join('  ·  ')) + '</div>';
      }
    }
    html += '<div class="row" style="margin-top:10px">'
      + '<button class="btn small" data-act="addLib">+ 添加例程库…</button>'
      + '<span class="muted">选择包含 &lt;芯片&gt;/EVT/EXAM/&lt;分类&gt;/&lt;例程&gt; 结构的目录；多个库并存，Examples 视图按库分组</span>'
      + '</div>';
    el.innerHTML = html;
  }

  function renderSettings(st) {
    var el = document.getElementById('settings-section');
    el.innerHTML =
      '<div class="setting-row"><label class="main">调试提供方<span class="muted">cortex-debug 提供 SVD 外设寄存器视图；cppdbg 无需额外扩展</span></label>'
      + '<select id="set-provider">'
      + ['auto', 'cortex-debug', 'cppdbg'].map(function (v) {
        return '<option value="' + v + '"' + (st.provider === v ? ' selected' : '') + '>' + v + '</option>';
      }).join('')
      + '</select></div>'
      + '<div class="setting-row"><label class="main">烧录后校验<span class="muted">openocd program … verify</span></label>'
      + '<label class="check"><input type="checkbox" id="set-verify"' + (st.verify ? ' checked' : '') + '> 启用</label></div>'
      + '<div class="setting-row"><label class="main">擦除模式<span class="muted">chip-default = program 时按芯片默认擦除；sectors-only = 仅擦除写入扇区</span></label>'
      + '<select id="set-eraseMode">'
      + ['chip-default', 'sectors-only'].map(function (v) {
        return '<option value="' + v + '"' + (st.eraseMode === v ? ' selected' : '') + '>' + v + '</option>';
      }).join('')
      + '</select></div>'
      + '<div class="setting-row"><label class="main">OpenOCD 端口<span class="muted">与其它 GDB 会话冲突时修改</span></label>'
      + '<span class="row">GDB <input type="number" id="set-gdbPort" value="' + st.gdbPort + '">'
      + ' telnet <input type="number" id="set-telnetPort" value="' + st.telnetPort + '">'
      + ' tcl <input type="number" id="set-tclPort" value="' + st.tclPort + '"></span></div>';

    function post(key, value) { vscode.postMessage({ t: 'set', key: key, value: value }); }
    document.getElementById('set-provider').addEventListener('change', function () { post('provider', this.value); });
    document.getElementById('set-verify').addEventListener('change', function () { post('verify', this.checked); });
    document.getElementById('set-eraseMode').addEventListener('change', function () { post('eraseMode', this.value); });
    ['gdbPort', 'telnetPort', 'tclPort'].forEach(function (k) {
      document.getElementById('set-' + k).addEventListener('change', function () { post(k, Number(this.value)); });
    });
  }

  function renderProject(a) {
    var wrap = document.getElementById('project-section-wrap');
    if (!a) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    document.getElementById('project-section').innerHTML =
      '<div class="kv">'
      + '<span>工程 <b>' + esc(a.name) + '</b></span>'
      + '<span>MCU <b>' + esc(a.mcuId) + '</b></span>'
      + '<span>系列 <b>' + esc(a.series) + '</b></span>'
      + '<span>工具链 <b>' + esc(a.toolchain) + '</b></span>'
      + '<span>配置 <b>' + esc(a.config) + '</b></span>'
      + '</div>';
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) { return; }
    var act = t.getAttribute('data-act');
    if (act === 'browseInstall' || act === 'addLib' || act === 'runSetup' || act === 'openSettings' || act === 'detect') {
      vscode.postMessage({ t: act });
    } else if (act === 'useRoot') {
      vscode.postMessage({ t: 'useRoot', root: t.getAttribute('data-root') });
    } else if (act === 'removeLib') {
      vscode.postMessage({ t: 'removeLib', dir: t.getAttribute('data-dir') });
    } else if (act === 'openLib') {
      vscode.postMessage({ t: 'openLib', dir: t.getAttribute('data-dir') });
    } else if (act === 'autoDetect') {
      vscode.postMessage({ t: 'autoDetect' });
    }
  });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && m.t === 'state') { render(m.state); }
  });

  vscode.postMessage({ t: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

function iconChip(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="36" height="36" xmlns="http://www.w3.org/2000/svg">
    <rect x="6" y="6" width="12" height="12" rx="2"/>
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" fill="currentColor" stroke="none"/>
    <line x1="9" y1="2" x2="9" y2="5.4"/><line x1="15" y1="2" x2="15" y2="5.4"/>
    <line x1="9" y1="18.6" x2="9" y2="22"/><line x1="15" y1="18.6" x2="15" y2="22"/>
    <line x1="2" y1="9" x2="5.4" y2="9"/><line x1="2" y1="15" x2="5.4" y2="15"/>
    <line x1="18.6" y1="9" x2="22" y2="9"/><line x1="18.6" y1="15" x2="22" y2="15"/>
  </svg>`;
}
