import fs from 'node:fs';
import path from 'node:path';
import { intro, outro, confirm, text, isCancel, cancel, log } from '@clack/prompts';
import { findConfigPath } from './load-config.js';
import { installSkill } from './skill.js';

/** The scaffolded `devtooie.config.ts`: meta + packages + the inline type augmentation. */
function configTemplate(apiPort: number): string {
  return `import { defineConfig } from 'devtooie';

const config = defineConfig({
  apiPort: ${apiPort},
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

  const apiPortAnswer = await text({
    message: 'Control API port?',
    defaultValue: '4099',
    placeholder: '4099',
    validate: (value) => {
      if (!value) return undefined;
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        return 'must be a port number between 1 and 65535';
      }
      return undefined;
    },
  });
  if (isCancel(apiPortAnswer)) {
    cancel('Setup cancelled.');
    return;
  }

  // All prompts answered without cancellation — now perform the (idempotent) writes.
  const skill = skillAnswer;
  const apiPort = Number(apiPortAnswer);

  const configPath = path.join(cwd, 'devtooie.config.ts');
  if (opts.force || !existingConfig) {
    fs.writeFileSync(configPath, configTemplate(apiPort));
    log.step('Scaffolded devtooie.config.ts');
  } else {
    log.step(`Kept existing ${path.basename(existingConfig)}`);
  }

  if (skill) {
    const version = readOwnVersion();
    installSkill({ cwd, version });
    log.step('Installed agent skill');
  }

  outro('devtooie is set up.');
}
