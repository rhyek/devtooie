import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_PORT_MIN,
  CONTROL_PORT_COUNT,
  readRunning,
  writeRunning,
  pickRandomPort,
  decideControlPort,
  type PortEnv,
  type InstanceInfo,
} from './running.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-running-'));
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const inRange = (p: number) => p >= CONTROL_PORT_MIN && p < CONTROL_PORT_MIN + CONTROL_PORT_COUNT;

/** A fake {@link PortEnv} whose network behavior is fully scripted. */
function fakeEnv(opts: {
  listening?: number[];
  info?: Record<number, InstanceInfo>;
  onShutdown?: (port: number, pid: number) => void;
}): PortEnv {
  const listening = new Set(opts.listening ?? []);
  return {
    isListening: (port) => Promise.resolve(listening.has(port)),
    probe: (port) => Promise.resolve(opts.info?.[port] ?? null),
    shutdown: (port, pid) => {
      opts.onShutdown?.(port, pid);
      return Promise.resolve();
    },
  };
}

describe('pickRandomPort', () => {
  it('returns a port within the configured range', () => {
    for (let i = 0; i < 50; i++) expect(inRange(pickRandomPort())).toBe(true);
  });
  it('never returns an excluded port', () => {
    const exclude = [];
    for (let p = CONTROL_PORT_MIN; p < CONTROL_PORT_MIN + CONTROL_PORT_COUNT - 1; p++)
      exclude.push(p);
    // Only the last port is available.
    expect(pickRandomPort(exclude)).toBe(CONTROL_PORT_MIN + CONTROL_PORT_COUNT - 1);
  });
});

describe('readRunning / writeRunning', () => {
  it('round-trips state and returns null when the file is missing', () => {
    expect(readRunning(cwd)).toBeNull();
    writeRunning(cwd, { port: 14042, pid: 1234 });
    expect(readRunning(cwd)).toEqual({ port: 14042, pid: 1234 });
  });
  it('returns null for a malformed file', () => {
    const file = path.join(cwd, 'node_modules', '.devtooie', 'running.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    expect(readRunning(cwd)).toBeNull();
  });
});

describe('decideControlPort — random mode', () => {
  const configPath = '/repo/devtooie.config.ts';

  it('picks a fresh in-range port and records it when no running.json exists', async () => {
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env: fakeEnv({}) });
    expect(inRange(port)).toBe(true);
    expect(readRunning(cwd)).toEqual({ port, pid: 4242 });
  });

  it('reuses the recorded port (updating pid) when it is not being listened to', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env: fakeEnv({}) });
    expect(port).toBe(14050);
    expect(readRunning(cwd)).toEqual({ port: 14050, pid: 4242 });
  });

  it('hands off (shuts down) and reuses the port when the same workspace is listening', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    const shutdowns: [number, number][] = [];
    const env = fakeEnv({
      listening: [14050],
      info: { 14050: { pid: 999, configPath } },
      onShutdown: (p, pid) => shutdowns.push([p, pid]),
    });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env });
    expect(port).toBe(14050);
    expect(shutdowns).toEqual([[14050, 999]]);
    expect(readRunning(cwd)).toEqual({ port: 14050, pid: 4242 });
  });

  it('relocates without shutting down when a DIFFERENT workspace holds the port', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    let shutdownCalled = false;
    const env = fakeEnv({
      listening: [14050],
      info: { 14050: { pid: 999, configPath: '/other/devtooie.config.ts' } },
      onShutdown: () => (shutdownCalled = true),
    });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env });
    expect(shutdownCalled).toBe(false);
    expect(port).not.toBe(14050);
    expect(inRange(port)).toBe(true);
    expect(readRunning(cwd)).toEqual({ port, pid: 4242 });
  });

  it('relocates when the port is held by a non-devtooie listener', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    const env = fakeEnv({ listening: [14050] /* no info → probe returns null */ });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env });
    expect(port).not.toBe(14050);
    expect(inRange(port)).toBe(true);
  });
});

describe('decideControlPort — explicit apiPort override', () => {
  const configPath = '/repo/devtooie.config.ts';

  it('uses the fixed port and hands off the same workspace', async () => {
    const shutdowns: [number, number][] = [];
    const env = fakeEnv({
      listening: [5000],
      info: { 5000: { pid: 999, configPath } },
      onShutdown: (p, pid) => shutdowns.push([p, pid]),
    });
    const port = await decideControlPort({
      cwd,
      configPath,
      pid: 4242,
      apiPortOverride: 5000,
      env,
    });
    expect(port).toBe(5000);
    expect(shutdowns).toEqual([[5000, 999]]);
    expect(readRunning(cwd)).toEqual({ port: 5000, pid: 4242 });
  });

  it('keeps the fixed port but does NOT shut down a foreign occupant', async () => {
    let shutdownCalled = false;
    const env = fakeEnv({
      listening: [5000],
      info: { 5000: { pid: 999, configPath: '/other/devtooie.config.ts' } },
      onShutdown: () => (shutdownCalled = true),
    });
    const port = await decideControlPort({
      cwd,
      configPath,
      pid: 4242,
      apiPortOverride: 5000,
      env,
    });
    expect(port).toBe(5000);
    expect(shutdownCalled).toBe(false);
  });
});
