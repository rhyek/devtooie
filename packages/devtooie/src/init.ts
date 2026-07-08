import fs from 'node:fs';
import path from 'node:path';
import { intro, outro, confirm, isCancel, cancel, log } from '@clack/prompts';
import { findConfigPath } from './load-config.js';
import { installSkill } from './skill.js';
import { reconcileTsconfig } from './tsconfig.js';

/** The scaffolded `devtooie.config.ts`: meta + packages + the inline type augmentation. */
function configTemplate(): string {
  return `import { defineConfig } from 'devtooie';

const config = defineConfig({
  // tokens: { domain: process.env.APP_DOMAIN, proxyport: process.env.PROXY_PORT },
  packages: [
    // { name: 'my-pkg', types: ['backend'], run: { port: 3001 } },
  ],
});
export default config;

// Wires your package names into devtooie's types. Keep as-is.
declare module 'devtooie' {
  interface Register {
    packageConfigs: typeof config.packages;
  }
}
`;
}

/** Reads this package's own version (for the skill install banner). Falls back to '0.0.0'. */
function readOwnVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Interactive `devtooie init` setup flow. Idempotent: an existing `devtooie.config.ts`
 * is left untouched (pass `force: true` to overwrite); the agent skill is (re)installed
 * whenever chosen.
 *
 * Does NOT prompt for a logfile location — that default is fixed at
 * `node_modules/.devtooie/devlog.txt` and is only overridable via the `--logfile` CLI flag.
 */
export async function runInit(opts: { cwd?: string; force?: boolean } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const existingConfig = findConfigPath(cwd);

  intro('devtooie init');

  const skillAnswer = await confirm({
    message: 'Install the devtooie agent skill?',
    initialValue: true,
  });
  if (isCancel(skillAnswer)) {
    cancel('Setup cancelled.');
    return;
  }

  // Prompt answered without cancellation — now perform the (idempotent) writes.
  const skill = skillAnswer;

  const configPath = path.join(cwd, 'devtooie.config.ts');
  if (opts.force || !existingConfig) {
    fs.writeFileSync(configPath, configTemplate());
    log.step('Scaffolded devtooie.config.ts');
  } else {
    log.step(`Kept existing ${path.basename(existingConfig)}`);
  }

  // Make sure a root tsconfig type-checks the config with node globals in scope, so editors
  // don't flag `process.env.*` in it with TS2591. Idempotent; never clobbers existing settings.
  const configFile = path.basename(existingConfig ?? configPath);
  const tsOutcome = reconcileTsconfig({ cwd, configFile });
  if (tsOutcome === 'created') {
    log.step('Created tsconfig.json');
  } else if (tsOutcome === 'updated') {
    log.step(`Added ${configFile} to tsconfig.json include`);
  }

  if (skill) {
    const version = readOwnVersion();
    installSkill({ cwd, version });
    log.step('Installed agent skill');
  }

  outro('devtooie is set up.');
}
