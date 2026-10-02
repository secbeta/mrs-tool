import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await fsp.readFile(p, 'utf-8')) as T;
}

export async function mkdirp(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

/**
 * Write a file only when the content actually changed — keeps timestamps and
 * git state stable across "regenerate everything" operations.
 */
export async function writeIfChanged(p: string, content: string): Promise<boolean> {
  const before = await fsp.readFile(p, 'utf-8').catch(() => undefined);
  if (before === content) {
    return false;
  }
  await mkdirp(path.dirname(p));
  await fsp.writeFile(p, content, 'utf-8');
  return true;
}

/** Read a JSON file preserving key order/unknown fields; returns undefined when missing. */
export async function readJsonIfExists<T = unknown>(p: string): Promise<T | undefined> {
  if (!(await pathExists(p))) {
    return undefined;
  }
  return readJson<T>(p);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Normalize a path for use inside the generated Makefile (forward slashes). */
export function toMakePath(p: string): string {
  return toPosix(p).replace(/ /g, '\\ ');
}
