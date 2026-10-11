import { findPackage } from '../config.js';
import { loadConfigOrExit, loadedConfigOrExit, validatePackageNames } from './workspace.js';

// The read-only commands that print what the config resolves to.

/** `devtooie show-config`: the fully resolved config, as JSON. */
export async function showConfig(): Promise<never> {
  // The config is resolved exactly once, when the file loads (callbacks run, defaults applied,
  // `command` normalized); this is that object, serialized the way the control API serves it.
  // Function-valued fields (`logs.formatter`) have no JSON form and are omitted, there too.
  console.log(JSON.stringify(await loadedConfigOrExit(), null, 2));
  process.exit(0);
}

/** `devtooie resolvedeps <package>`: its build/dev/runtime deps, as JSON. */
export async function resolveDepsCommand(packageName: string): Promise<never> {
  await loadConfigOrExit();
  validatePackageNames([packageName]);
  // Only here, not up top: `show-config` has no use for what resolving dependencies loads.
  const { DepType, resolveDeps } = await import('../lib.js');
  const packages = [findPackage(packageName)];
  const selectedNames = new Set(packages.map((p) => p.name));

  const build = resolveDeps(packages, [DepType.BUILD]);
  const dev = resolveDeps(packages, [DepType.DEV]);
  const runtime = resolveDeps(packages, [DepType.RUNTIME]);

  console.log(
    JSON.stringify(
      {
        build: [...build.buildSet].filter((n) => !selectedNames.has(n)),
        dev: [...dev.buildSet].filter((n) => !selectedNames.has(n)),
        runtime: [...runtime.runSet].filter((n) => !selectedNames.has(n)),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
