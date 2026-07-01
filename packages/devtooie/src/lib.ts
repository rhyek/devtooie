import fs from 'node:fs';
import path from 'node:path';
import type { AnyAppConfig } from './config.js';

export function getStateDir(): string {
  const dir = path.join(process.cwd(), 'node_modules', '.devtooie');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const RUNNER_MANAGED = new Set(['dev', 'build', 'build:clean', 'build-clean', 'clean']);

function readPackageJson(app: AnyAppConfig): { scripts?: Record<string, string> } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.path, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function getCommandRunner(app: AnyAppConfig): 'pnpm' | 'make' {
  if (fs.existsSync(path.join(app.path, 'package.json'))) return 'pnpm';
  if (fs.existsSync(path.join(app.path, 'Makefile'))) return 'make';
  return 'pnpm';
}

export function getExecArgs(app: AnyAppConfig, script: string): [string, string[]] {
  return getCommandRunner(app) === 'make' ? ['make', [script]] : ['pnpm', ['run', script]];
}

export function hasScript(app: AnyAppConfig, script: string): boolean {
  if (getCommandRunner(app) === 'make') return getMakeTargets(app).includes(script);
  return Boolean(readPackageJson(app)?.scripts?.[script]);
}

export function hasDevScript(app: AnyAppConfig): boolean {
  return hasScript(app, 'dev');
}

export function getMakeTargets(app: AnyAppConfig): string[] {
  try {
    const mk = fs.readFileSync(path.join(app.path, 'Makefile'), 'utf8');
    return [...mk.matchAll(/^([a-zA-Z0-9_.-]+):/gm)].map((m) => m[1]!);
  } catch {
    return [];
  }
}

export function getExtraCommands(app: AnyAppConfig): string[] {
  const names =
    getCommandRunner(app) === 'make'
      ? getMakeTargets(app)
      : Object.keys(readPackageJson(app)?.scripts ?? {});
  return names.filter((n) => !RUNNER_MANAGED.has(n));
}
