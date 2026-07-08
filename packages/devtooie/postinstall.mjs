import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  // Gate 1: Skip if CI=true
  if (process.env.CI) {
    process.exit(0);
  }

  // Gate 2: Skip if stdout is not a TTY
  if (!process.stdout.isTTY) {
    process.exit(0);
  }

  // Gate 3: Decide whether devtooie still needs setup — either no config, or a config
  // exists but the agent skill isn't installed. Delegates to devtooie's own setup-status
  // logic so the config-file names and skill-install paths stay single-sourced (see
  // src/setup-status.ts).
  const initCwd = process.env.INIT_CWD || process.cwd();
  const { setupNag } = await import('./dist/setup-status.js');
  const nag = setupNag(initCwd);
  if (!nag.prompt) {
    process.exit(0);
  }

  // Prompt user
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question(`${nag.message} (Y/n) `, (answer) => {
    rl.close();

    const isYes = !answer || answer.toLowerCase() === 'y';

    if (isYes) {
      // Run devtooie init
      const cliPath = path.join(__dirname, 'dist', 'cli.js');
      const child = spawn('node', [cliPath, 'init'], {
        cwd: initCwd,
        stdio: 'inherit',
      });

      child.on('exit', () => {
        process.exit(0);
      });
      child.on('error', () => process.exit(0));
    } else {
      console.log("Run `devtooie init` when you're ready to set up devtooie.");
      process.exit(0);
    }
  });
} catch (_error) {
  // Never throw - always exit 0
  process.exit(0);
}
