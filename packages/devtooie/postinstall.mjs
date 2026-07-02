import fs from 'node:fs';
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

  // Gate 3: Skip if devtooie.yaml or devtooie.yml exists
  const initCwd = process.env.INIT_CWD || process.cwd();
  const yamlPath = path.join(initCwd, 'devtooie.yaml');
  const ymlPath = path.join(initCwd, 'devtooie.yml');

  if (fs.existsSync(yamlPath) || fs.existsSync(ymlPath)) {
    process.exit(0);
  }

  // Prompt user
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Set up devtooie now? runs `devtooie init` (Y/n) ', (answer) => {
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
    } else {
      console.log("Run `devtooie init` when you're ready to set up devtooie.");
      process.exit(0);
    }
  });
} catch (_error) {
  // Never throw - always exit 0
  process.exit(0);
}
