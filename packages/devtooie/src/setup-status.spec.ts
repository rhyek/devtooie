import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSkillMissing, setupNag } from './setup-status.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtooie-setup-'));
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

function writeConfig(): void {
  fs.writeFileSync(path.join(cwd, 'devtooie.config.ts'), 'export default {};\n');
}
function makeAgentDir(dir: string, withSkill: boolean): void {
  fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  if (withSkill) {
    const skill = path.join(cwd, dir, 'skills', 'devtooie', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, '# skill\n');
  }
}

describe('isSkillMissing', () => {
  it('is false when no agent-tooling dir exists', () => {
    expect(isSkillMissing(cwd)).toBe(false);
  });

  it('is false when .claude exists and holds the skill', () => {
    makeAgentDir('.claude', true);
    expect(isSkillMissing(cwd)).toBe(false);
  });

  it('is true when .claude exists but lacks the skill', () => {
    makeAgentDir('.claude', false);
    expect(isSkillMissing(cwd)).toBe(true);
  });

  it('is true when any existing agent dir lacks the skill', () => {
    makeAgentDir('.claude', true);
    makeAgentDir('.agents', false);
    expect(isSkillMissing(cwd)).toBe(true);
  });

  it('is false when the only agent dir is .agents and it holds the skill', () => {
    makeAgentDir('.agents', true);
    expect(isSkillMissing(cwd)).toBe(false);
  });
});

describe('setupNag', () => {
  it('prompts to set up when nothing is present', () => {
    const nag = setupNag(cwd);
    expect(nag.prompt).toBe(true);
    expect(nag.message).toMatch(/set up devtooie/i);
  });

  it('prompts with the setup message when no config exists even if an agent dir lacks the skill', () => {
    makeAgentDir('.claude', false);
    const nag = setupNag(cwd);
    expect(nag.prompt).toBe(true);
    expect(nag.message).toMatch(/set up devtooie/i);
  });

  it('skips when a config exists and no agent dir is present', () => {
    writeConfig();
    expect(setupNag(cwd).prompt).toBe(false);
  });

  it('skips when a config exists and the skill is installed', () => {
    writeConfig();
    makeAgentDir('.claude', true);
    expect(setupNag(cwd).prompt).toBe(false);
  });

  it('prompts with the skill message when a config exists but the skill is missing', () => {
    writeConfig();
    makeAgentDir('.claude', false);
    const nag = setupNag(cwd);
    expect(nag.prompt).toBe(true);
    expect(nag.message).toMatch(/skill/i);
    expect(nag.message).not.toMatch(/set up devtooie/i);
  });
});
