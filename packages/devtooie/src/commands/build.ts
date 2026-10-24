import path from 'node:path';
import chalk from 'chalk';
import { execa } from 'execa';
import { type AnyServiceConfig, findService } from '../config.js';
import { DepType, hasScript, resolveDeps, runScript } from '../lib.js';

// Building packages with console output: the `--build` / `--rebuild` phase, and the build-time
// deps a `--plain` session builds before it starts anything.

async function clearDist(pkg: AnyServiceConfig): Promise<void> {
  const result = await execa('rm', ['-rf', path.join(pkg.absoluteDir, 'dist')], { reject: false });
  if (result.exitCode !== 0) {
    console.error(`warning: could not clear ${path.join(pkg.absoluteDir, 'dist')}`);
  }
}

async function buildOne(pkg: AnyServiceConfig, script: string): Promise<void> {
  await runScript(pkg, script, 'inherit');
}

/** Builds every buildable dep in `deps.buildSet`, in dependency order, with console output. */
export async function buildDeps(deps: ReturnType<typeof resolveDeps>): Promise<void> {
  const depPackages = [...deps.buildSet]
    .map((n) => findService(n))
    .filter((p) => hasScript(p, 'build'));
  for (const [i, pkg] of depPackages.entries()) {
    console.log(
      `${chalk.blue('▶')} building dep (${i + 1}/${depPackages.length}): ${chalk.bold(pkg.name)}`,
    );
    await buildOne(pkg, 'build');
  }
  if (depPackages.length > 0) {
    console.log(chalk.green('✔ dependencies built'));
  }
}

/** `--phase build` / `--build` / `--rebuild`: build deps then the selected packages, then exit. */
export async function runBuildPhase(names: string[], rebuild: boolean): Promise<void> {
  const packages = names.map((n) => findService(n));
  const deps = resolveDeps(packages, [DepType.BUILD]);
  const depPackages = [...deps.buildSet]
    .map((n) => findService(n))
    .filter((p) => hasScript(p, 'build'));
  const selectedPackages = packages.filter(
    (p) => hasScript(p, 'build') || hasScript(p, 'build:clean'),
  );

  if (rebuild) {
    console.log(chalk.blue('▶ clearing dist/'));
    for (const pkg of [...depPackages, ...selectedPackages]) {
      await clearDist(pkg);
    }
  }

  for (const [i, pkg] of depPackages.entries()) {
    console.log(
      `${chalk.blue('▶')} building dep (${i + 1}/${depPackages.length}): ${chalk.bold(pkg.name)}`,
    );
    await buildOne(pkg, 'build');
  }

  for (const pkg of selectedPackages) {
    const script = rebuild && hasScript(pkg, 'build:clean') ? 'build:clean' : 'build';
    console.log(`${chalk.blue('▶')} building: ${chalk.bold(pkg.name)}`);
    await buildOne(pkg, script);
  }

  console.log(chalk.green('✔ build complete'));
}
