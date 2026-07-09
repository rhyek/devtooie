// Generates `src/config.generated.ts` from the Zod schemas in `src/config-schema.ts`,
// turning each `.describe()` into a JSDoc comment. Runs directly via Node's TypeScript
// support (no build needed) because `config-schema.ts` imports only `zod`. `config.ts`
// composes the public types from the generated ones, overriding the fields Zod can't
// represent.
import { zodToTs, createTypeAlias, printNode, createAuxiliaryTypeStore } from 'zod-to-ts';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { RunConfigSchema, PackageConfigSchema, DefineConfigSchema } from '../src/config-schema.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'src', 'config.generated.ts');

function gen(schema: Parameters<typeof zodToTs>[0], name: string): string {
  const { node } = zodToTs(schema, {
    auxiliaryTypeStore: createAuxiliaryTypeStore(),
    unrepresentable: 'any',
  });
  return 'export ' + printNode(createTypeAlias(node, name));
}

const header = `// AUTO-GENERATED from config-schema.ts by scripts/gen-config-types.ts — DO NOT EDIT.
// Regenerate with \`pnpm --filter devtooie gen\` (also runs as part of \`pnpm build\`).
// Field docs come from the schemas' \`.describe()\`; \`command\`/\`waitFor\`/\`deps\`/\`name\`/\`run\`/
// \`packages\` are overridden in config.ts, so their generated form here is intentionally ignored.
/* eslint-disable */
`;

const body = [
  gen(RunConfigSchema, 'GeneratedRunConfig'),
  gen(PackageConfigSchema, 'GeneratedPackageConfig'),
  gen(DefineConfigSchema, 'GeneratedDefineConfig'),
].join('\n\n');

fs.writeFileSync(outFile, header + '\n' + body + '\n');
console.log('wrote', path.relative(process.cwd(), outFile));
