import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface ProjectConfig {
  services: string;
  apiPort: number;
  skill: boolean;
}

export function findProjectConfigPath(cwd: string = process.cwd()): string | null {
  for (const name of ['devtooie.yaml', 'devtooie.yml']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function getProjectConfig(cwd: string = process.cwd()): ProjectConfig | null {
  const p = findProjectConfigPath(cwd);
  if (!p) return null;
  let raw: Partial<ProjectConfig>;
  try {
    raw = (YAML.parse(fs.readFileSync(p, 'utf8')) ?? {}) as Partial<ProjectConfig>;
  } catch (err) {
    throw new Error(`invalid ${path.basename(p)}: ${(err as Error).message}`, { cause: err });
  }
  return {
    services: raw.services ?? './services.ts',
    apiPort: raw.apiPort ?? 4099,
    skill: raw.skill ?? false,
  };
}

export function writeProjectConfig(cfg: ProjectConfig, cwd: string = process.cwd()): void {
  fs.writeFileSync(path.join(cwd, 'devtooie.yaml'), YAML.stringify(cfg));
}
