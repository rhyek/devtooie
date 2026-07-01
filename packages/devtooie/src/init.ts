import fs from 'node:fs';
import path from 'node:path';
import { intro, outro, confirm, text, isCancel, cancel, log } from '@clack/prompts';
import { getProjectConfig, writeProjectConfig } from './project-config.js';
import { installSkill } from './skill.js';
import { runTypegen } from './typegen.js';

const SERVICES_TEMPLATE = `import { defineAppConfigs } from 'devtooie';

export default defineAppConfigs({
  // tokens: { domain: process.env.APP_DOMAIN, proxyport: process.env.PROXY_PORT },
  apps: [
    // { name: 'my-svc', types: ['backend'], run: { port: 3001 } },
  ],
});
`;

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
 * Interactive `devtooie init` setup flow (§15.2). Idempotent: re-running reads any
 * existing `devtooie.yaml` and uses its values as prompt defaults, then overwrites it.
 *
 * Does NOT prompt for a logfile location — that default is fixed at
 * `node_modules/.devtooie/devlog.txt` and is only overridable via the `--logfile` CLI flag.
 */
export async function runInit(opts: { cwd?: string; force?: boolean } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const existing = getProjectConfig(cwd);

  intro('devtooie init');

  const skillAnswer = await confirm({
    message: 'Install the devtooie agent skill?',
    initialValue: existing?.skill ?? true,
  });
  if (isCancel(skillAnswer)) {
    cancel('Setup cancelled.');
    return;
  }

  const servicesAnswer = await text({
    message: 'Where is your services file?',
    defaultValue: existing?.services ?? './services.ts',
    placeholder: './services.ts',
  });
  if (isCancel(servicesAnswer)) {
    cancel('Setup cancelled.');
    return;
  }

  const apiPortAnswer = await text({
    message: 'Control API port?',
    defaultValue: String(existing?.apiPort ?? 4099),
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
  const services = servicesAnswer;
  const apiPort = Number(apiPortAnswer);

  const servicesPath = path.resolve(cwd, services);
  if (opts.force || !fs.existsSync(servicesPath)) {
    fs.mkdirSync(path.dirname(servicesPath), { recursive: true });
    fs.writeFileSync(servicesPath, SERVICES_TEMPLATE);
    log.step(`Scaffolded ${services}`);
  }

  writeProjectConfig({ services, apiPort, skill }, cwd);
  log.step('Wrote devtooie.yaml');

  if (skill) {
    const version = readOwnVersion();
    installSkill({ cwd, version });
    runTypegen({ cwd });
    log.step('Installed agent skill and generated devtooie-env.d.ts');
  }

  outro('devtooie is set up.');
}
