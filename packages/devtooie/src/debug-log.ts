import fs from 'node:fs';
import path from 'node:path';
import { getStateDir } from './lib.js';

export function debugLog(...args: unknown[]): void {
  if (!process.env.DEBUG_DEVTOOIE) {
    return;
  }
  try {
    const dir = getStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${args.map(String).join(' ')}\n`;
    fs.appendFileSync(path.join(dir, 'debug.log'), line);
  } catch {
    // never throw from a logger
  }
}
