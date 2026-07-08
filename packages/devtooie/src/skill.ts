import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BANNER_RE = /^<!-- devtooie skill v.*? — managed by `devtooie init`; do not edit -->\n+/;

function banner(version: string): string {
  return `<!-- devtooie skill v${version} — managed by \`devtooie init\`; do not edit -->\n\n`;
}

/** Reads the shipped `assets/skill.md` template and prepends/refreshes the managed banner. */
export function renderSkill(version: string): string {
  const templatePath = path.join(import.meta.dirname, '../assets/skill.md');
  const template = fs.readFileSync(templatePath, 'utf8');
  const body = template.replace(BANNER_RE, '');
  return banner(version) + body;
}

export function contentHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Reads devtooie's own version (for the skill banner). Falls back to '0.0.0'. */
export function readOwnVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** `true` when `a` is an older semver-ish (`x.y.z`) version than `b`. */
function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb;
  }
  return false;
}

interface SkillState {
  /** Every path devtooie installed the skill to (`.claude/…`, and `.agents/`/`.cursor/` when present). */
  paths: string[];
  version: string;
  hash: string;
}

function stateDir(cwd: string): string {
  const dir = path.join(cwd, 'node_modules', '.devtooie');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFile(cwd: string): string {
  return path.join(stateDir(cwd), 'skill.json');
}

function readState(cwd: string): SkillState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(cwd), 'utf8')) as SkillState;
  } catch {
    return null;
  }
}

function writeSkillFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// Best-effort secondary install targets: mirrored under any of these dirs
// that already exist, alongside the canonical `.claude/` install.
const OPTIONAL_DIRS = ['.agents', '.cursor'];

/** Canonical install path for the managed skill file (`.claude/skills/devtooie/SKILL.md`). */
export function skillInstallPath(cwd: string): string {
  return path.join(cwd, '.claude', 'skills', 'devtooie', 'SKILL.md');
}

/** `true` when the managed skill file is already installed at `cwd`. */
export function isSkillInstalled(cwd: string): boolean {
  return fs.existsSync(skillInstallPath(cwd));
}

/**
 * Writes the rendered skill to `.claude/skills/devtooie/SKILL.md` (always) and, when
 * present, `.agents/` / `.cursor/` (best-effort). Records the installed path(s) +
 * version + content-hash in `node_modules/.devtooie/skill.json`.
 */
export function installSkill(opts: { cwd?: string; version: string }): void {
  const cwd = opts.cwd ?? process.cwd();
  const content = renderSkill(opts.version);
  const paths: string[] = [];

  const claudePath = path.join(cwd, '.claude', 'skills', 'devtooie', 'SKILL.md');
  writeSkillFile(claudePath, content);
  paths.push(claudePath);

  for (const dir of OPTIONAL_DIRS) {
    if (!fs.existsSync(path.join(cwd, dir))) continue;
    try {
      const p = path.join(cwd, dir, 'skills', 'devtooie', 'SKILL.md');
      writeSkillFile(p, content);
      paths.push(p);
    } catch {
      // best-effort: a secondary install target failing shouldn't fail setup.
    }
  }

  const state: SkillState = { paths, version: opts.version, hash: contentHash(content) };
  fs.writeFileSync(stateFile(cwd), JSON.stringify(state, null, 2));
}

/**
 * Per §15.5: if a managed skill file was installed at an older version than `version`
 * and the on-disk file's hash still matches what devtooie last wrote (i.e. unedited),
 * rewrites it (and all other recorded install targets) with the current template. If
 * the file was hand-edited (hash mismatch), it is left untouched.
 */
export function refreshSkillIfStale(opts: { cwd?: string; version: string }): void {
  const cwd = opts.cwd ?? process.cwd();
  const state = readState(cwd);
  if (!state || !isOlder(state.version, opts.version)) return;

  const canonical = state.paths[0];
  if (!canonical || !fs.existsSync(canonical)) return;

  const onDisk = fs.readFileSync(canonical, 'utf8');
  if (contentHash(onDisk) !== state.hash) return; // hand-edited; leave untouched

  installSkill(opts);
}

/**
 * If the managed skill is already installed at `cwd`, silently re-render and overwrite it
 * (and every recorded install target) so it always matches the shipped template. Unlike
 * {@link refreshSkillIfStale} this is unconditional: it ignores the recorded version and
 * overwrites even a hand-edited file (the file is managed — "do not edit"). No-op when the
 * skill isn't installed. Returns whether an update happened. Used by `postinstall` and
 * `devtooie init` to keep the installed skill in lockstep without prompting.
 */
export function updateSkillIfPresent(opts: { cwd?: string; version?: string } = {}): boolean {
  const cwd = opts.cwd ?? process.cwd();
  if (!isSkillInstalled(cwd)) return false;
  installSkill({ cwd, version: opts.version ?? readOwnVersion() });
  return true;
}
