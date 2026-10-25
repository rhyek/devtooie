// zod-to-ts (the config-type codegen) is built on the TypeScript compiler API, which TypeScript 7
// doesn't ship. Its `typescript` peer would resolve to the workspace's 7, so it gets TypeScript 6
// as a dependency of its own instead.
export const hooks = {
  readPackage(pkg) {
    if (pkg.name === 'zod-to-ts') {
      delete pkg.peerDependencies?.typescript;
      pkg.dependencies = { ...pkg.dependencies, typescript: '^6.0.3' };
    }
    return pkg;
  },
};
