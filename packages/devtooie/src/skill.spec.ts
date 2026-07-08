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
  updateSkillIfPresent,
} from './skill.js';

describe('skill rendering', () => {
  it('embeds the managed banner with the version', () => {
    const out = renderSkill('1.2.3');
    expect(out).toContain('devtooie skill v1.2.3');
    expect(out).toContain('do not edit');
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

describe('isSkillInstalled + updateSkillIfPresent', () => {
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

  it('overwrites an existing skill even when the version is not older (unlike refresh)', () => {
    installSkill({ cwd, version: '2.0.0' });
    const file = path.join(cwd, '.claude/skills/devtooie/SKILL.md');
    // Simulate a template change under the SAME version — refresh would skip this.
    fs.writeFileSync(file, 'STALE CONTENT\n');
    const changed = updateSkillIfPresent({ cwd, version: '2.0.0' });
    expect(changed).toBe(true);
    const out = fs.readFileSync(file, 'utf8');
    expect(out).not.toContain('STALE CONTENT');
    expect(out).toContain('devtooie skill v2.0.0');
  });

  it('overwrites even a hand-edited skill file (managed file)', () => {
    installSkill({ cwd, version: '1.0.0' });
    const file = path.join(cwd, '.claude/skills/devtooie/SKILL.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nHAND EDIT\n');
    updateSkillIfPresent({ cwd, version: '1.0.0' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('HAND EDIT');
  });

  it('is a no-op returning false when the skill is not installed', () => {
    expect(updateSkillIfPresent({ cwd, version: '1.0.0' })).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.claude/skills/devtooie/SKILL.md'))).toBe(false);
  });
});
