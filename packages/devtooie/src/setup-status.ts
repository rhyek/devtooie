import fs from 'node:fs';
import path from 'node:path';
import { findConfigPath } from './load-config.js';

/**
 * Agent-tooling dirs that, when present, mean the user works with coding agents and so
 * should have devtooie's skill installed. Mirrors the canonical + optional install
 * targets `installSkill` writes to (see `skill.ts`).
 */
const AGENT_DIRS = ['.claude', '.agents'];

/** Where `installSkill` writes the skill under each agent-tooling dir. */
const SKILL_REL_PATH = path.join('skills', 'devtooie', 'SKILL.md');

/** The postinstall prompt shown when devtooie isn't set up at all. */
export const SETUP_MESSAGE = 'Set up devtooie now? runs `devtooie init`';

/** The postinstall prompt shown when devtooie is configured but the agent skill isn't installed. */
export const SKILL_MESSAGE =
  "devtooie's agent skill isn't installed. Install it now? runs `devtooie init`";

export interface SetupNag {
  /** Whether postinstall should prompt the user to run `devtooie init`. */
  prompt: boolean;
  /** The message to show when prompting. */
  message: string;
}

/**
 * `true` when an agent-tooling dir (`.claude`/`.agents`) exists at `cwd` but is missing
 * devtooie's installed skill file — i.e. the user works with agents but the skill isn't
 * (fully) installed. `false` when no such dir exists (the user isn't an agent user).
 */
export function isSkillMissing(cwd: string): boolean {
  const present = AGENT_DIRS.filter((dir) => fs.existsSync(path.join(cwd, dir)));
  if (present.length === 0) return false;
  return present.some((dir) => !fs.existsSync(path.join(cwd, dir, SKILL_REL_PATH)));
}

/**
 * Decides whether postinstall should nag the user to run `devtooie init`, and with which
 * message:
 * - no config → prompt to set devtooie up (covers "skill also missing").
 * - config present but skill missing → prompt to install the skill.
 * - config present and skill installed (or not an agent user) → skip.
 */
export function setupNag(cwd: string): SetupNag {
  const configPresent = findConfigPath(cwd) !== null;
  if (!configPresent) {
    return { prompt: true, message: SETUP_MESSAGE };
  }
  if (isSkillMissing(cwd)) {
    return { prompt: true, message: SKILL_MESSAGE };
  }
  return { prompt: false, message: '' };
}
