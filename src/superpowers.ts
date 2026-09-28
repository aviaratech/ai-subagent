import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { SubagentType } from './presets.js';

export interface ResolveSuperpowersSkillsInput {
  agentType: SubagentType;
  env?: NodeJS.ProcessEnv;
  purpose: string;
  skillRoots?: string[];
}

export interface SelectedSuperpowersSkill {
  digest: string;
  name: string;
  reference: string;
}

export interface SelectedSuperpowersSkills {
  names: string[];
  references: string[];
  skills: SelectedSuperpowersSkill[];
}

export function renderSuperpowersBootstrap(skills: SelectedSuperpowersSkills): string {
  const firstReference = skills.references[0];
  if (firstReference === undefined) {
    throw new Error('superpowers_skill_missing: using-superpowers.');
  }
  const remainingReferences = skills.references
    .slice(1)
    .map((reference, index) => `${String(index + 1)}. Read ${reference}`)
    .join('\n');
  return [
    '## Required Superpowers Bootstrap',
    '',
    `Read ${firstReference} before acting.`,
    ...(remainingReferences.length > 0 ? ['Then load:', remainingReferences] : []),
    'Load these files directly with the Read tool; do not invoke a host Skill tool.',
    'Reading each listed SKILL.md is the invocation for this child.',
    'Apply only the listed skills when their trigger applies. Do not invoke nested delegation or parallel child dispatch.',
  ].join('\n');
}

/**
 * Resolve only the skills relevant to the selected role. References point to
 * installed SKILL.md files so providers can load the host-native instructions
 * without receiving a copied catalog in their delegation prompt.
 */
export function resolveSuperpowersSkills(input: ResolveSuperpowersSkillsInput): SelectedSuperpowersSkills {
  const names = selectedSkillNames(input.agentType, input.purpose);
  const roots = input.skillRoots ?? defaultSkillRoots(input.env ?? process.env);
  const skills = names.map(name => resolveSkill(name, roots));
  return { names, references: skills.map(skill => skill.reference), skills };
}

function defaultSkillRoots(env: NodeJS.ProcessEnv): string[] {
  const configuredHome = env.HOME?.trim();
  const home = configuredHome === undefined || configuredHome.length === 0 ? homedir() : configuredHome;
  const configuredRoot = env.AI_SUBAGENT_SUPERPOWERS_SKILLS_ROOT?.trim();
  const roots = [
    ...(configuredRoot !== undefined && configuredRoot.length > 0 ? [configuredRoot] : []),
    join(home, '.codex', 'superpowers', 'skills'),
    join(home, '.agents', 'skills'),
  ];
  return [...new Set(roots.map(root => resolve(root)))];
}

function hasBranchFinishTrigger(purpose: string): boolean {
  return /\b(branch|merge|pr|publish)\b/u.test(purpose);
}

function hasDebugTrigger(purpose: string): boolean {
  return /\b(debug|failure|failing|regression|error)\b/u.test(purpose);
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === expectedCode
  );
}

function resolveSkill(name: string, roots: string[]): SelectedSuperpowersSkill {
  for (const root of roots) {
    const reference = join(root, name, 'SKILL.md');
    let stat;
    try {
      stat = lstatSync(reference);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        continue;
      }
      throw new Error(`superpowers_skill_unreadable: ${name}. The installed SKILL.md cannot be inspected.`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `superpowers_skill_invalid: ${name}. The installed SKILL.md must be a regular, non-symlink file.`,
      );
    }

    try {
      accessSync(reference, constants.R_OK);
      const content = readFileSync(reference);
      return {
        digest: createHash('sha256').update(content).digest('hex'),
        name,
        reference: realpathSync(reference),
      };
    } catch {
      throw new Error(`superpowers_skill_unreadable: ${name}. The installed SKILL.md must be readable.`);
    }
  }
  throw new Error(`superpowers_skill_missing: ${name}. Install the required Superpowers skill before delegating.`);
}

function selectedSkillNames(agentType: SubagentType, purpose: string): string[] {
  const normalizedPurpose = purpose.toLowerCase();
  if (agentType === 'ask') {
    return ['using-superpowers', hasDebugTrigger(normalizedPurpose) ? 'systematic-debugging' : 'brainstorming'];
  }
  if (agentType === 'builder') {
    return [
      'using-superpowers',
      'test-driven-development',
      ...(hasDebugTrigger(normalizedPurpose) ? ['systematic-debugging'] : []),
      'verification-before-completion',
      ...(hasBranchFinishTrigger(normalizedPurpose) ? ['finishing-a-development-branch'] : []),
    ];
  }
  if (agentType === 'reviewer') {
    return ['using-superpowers', 'verification-before-completion'];
  }
  return ['using-superpowers'];
}
