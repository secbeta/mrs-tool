import { spawn } from 'child_process';
import * as path from 'path';

export interface RunResult {
  code: number | null;
  output: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Default 0 = no timeout. */
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

/**
 * Spawn a process with an explicit argv (never through a shell) so paths with
 * Chinese characters or spaces survive intact. Streams merged output line by
 * line; resolves with the exit code (never rejects on non-zero exit).
 */
export function runProcess(exe: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let pending = '';
    const feed = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        opts.onLine?.(line);
      }
    };

    child.stdout.on('data', feed);
    child.stderr.on('data', feed);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }, opts.timeoutMs)
      : undefined;

    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (pending) {
        opts.onLine?.(pending);
      }
      resolve({ code, output });
    });

    child.on('error', (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      output += `\n${String(err)}`;
      resolve({ code: -1, output });
    });
  });
}

/**
 * Build the PATH used for toolchain invocations: MRS2 Make\bin (sh.exe!) and
 * the active toolchain bin directory take precedence over the system PATH.
 */
export function buildToolPath(first: string[], baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathVar = (baseEnv.PATH ?? baseEnv.Path ?? '') as string;
  const joined = [...first, pathVar].join(path.delimiter);
  return { ...baseEnv, PATH: joined, Path: joined };
}
