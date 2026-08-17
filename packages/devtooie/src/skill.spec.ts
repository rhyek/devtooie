import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderSkill,
  contentHash,
  installSkill,
  refreshSkillIfStale,
  isSkillInstalled,
} from './skill.js';

describe('skill rendering', () => {
  it('embeds the managed banner with the version', () => {
    const out = renderSkill('1.2.3');
    expect(out).toContain('devtooie skill v1.2.3');
    expect(out).toContain('do not edit');
  });

  // The regression that made this skill undiscoverable in every repo it was installed into.
  //
  // YAML frontmatter has to start on line 1. The banner used to be an HTML comment ABOVE it, so
  // the block was never parsed as frontmatter — and the agent saw the banner where `description`
  // should be. That field is the entire basis on which a skill is invoked, so the effect was a
  // skill that could not trigger, in a way nothing surfaces as an error.
  it('opens with frontmatter on line 1, with the banner INSIDE it', () => {
    const lines = renderSkill('1.2.3').split('\n');

    expect(lines[0]).toBe('---');
    expect(lines[1]).toContain('devtooie skill v1.2.3');
    expect(lines[1]!.startsWith('#')).toBe(true);

    // …and the fields a loader needs are still where it expects them.
    const close = lines.indexOf('---', 1);
    const frontmatter = lines.slice(1, close);
    expect(frontmatter.some((l) => l.startsWith('name:'))).toBe(true);
    expect(frontmatter.some((l) => l.startsWith('description:'))).toBe(true);
  });

  it('re-rendering an already-managed file does not stack banners', () => {
    // `refreshSkillIfStale` re-renders in place on every version bump.
    const once = renderSkill('1.2.3');
    const twice = renderSkill('1.2.4');
    expect(once.match(/do not edit/g)).toHaveLength(1);
    expect(twice.match(/do not edit/g)).toHaveLength(1);
    expect(twice).not.toContain('v1.2.3');
  });

  it('contentHash is stable and differs by input', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('skill install + refresh', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-skill-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it('installs then refreshes on version bump but preserves hand-edits', () => {
    installSkill({ cwd, version: '1.0.0' });
    const file = path.join(cwd, '.claude/skills/devtooie/SKILL.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'node_modules/.devtooie/skill.json'))).toBe(true);

    // Unedited → bump rewrites to new version.
    refreshSkillIfStale({ cwd, version: '1.1.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('v1.1.0');

    // Hand-edit → next bump leaves it untouched.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nHAND EDIT\n');
    refreshSkillIfStale({ cwd, version: '1.2.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('HAND EDIT');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('v1.2.0');
  });

  it('does not refresh when the recorded version is not older', () => {
    installSkill({ cwd, version: '1.0.0' });
    const file = path.join(cwd, '.claude/skills/devtooie/SKILL.md');
    refreshSkillIfStale({ cwd, version: '1.0.0' });
    expect(fs.readFileSync(file, 'utf8')).toContain('v1.0.0');
  });

  it('installs to .agents and .cursor when those dirs already exist', () => {
    fs.mkdirSync(path.join(cwd, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    installSkill({ cwd, version: '1.0.0' });
    expect(fs.existsSync(path.join(cwd, '.agents/skills/devtooie/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.cursor/skills/devtooie/SKILL.md'))).toBe(true);
    const state = JSON.parse(
      fs.readFileSync(path.join(cwd, 'node_modules/.devtooie/skill.json'), 'utf8'),
    ) as { paths: string[] };
    expect(state.paths).toHaveLength(3);
  });

  it('is a no-op when the skill was never installed', () => {
    expect(() => refreshSkillIfStale({ cwd, version: '9.9.9' })).not.toThrow();
  });
});

describe('isSkillInstalled', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-skill-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it('isSkillInstalled reflects whether the canonical skill file exists', () => {
    expect(isSkillInstalled(cwd)).toBe(false);
    installSkill({ cwd, version: '1.0.0' });
    expect(isSkillInstalled(cwd)).toBe(true);
  });
});
