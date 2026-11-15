import type { ProjectRegistry } from './project-registry.js';
import { readProjectContextSnapshot } from './project-context-snapshot.js';
import { readProjectGitStatus } from './project-git-status.js';
import { sanitizeForOutput } from './security.js';
import type { ProjectGitStatus } from './relay-protocol.js';
import type { SelectedProfile, ReasoningEffort } from './execution-profile.js';

const LIMIT = 2500;
function clean(value: unknown, limit = 240): string {
  const text = sanitizeForOutput(String(value ?? ''), limit).replace(/(?:password|secret|token|credential|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
  return text.replace(/[\r\n]+/g, ' ').trim();
}

export async function buildContextCapsule(input: {
  registry: ProjectRegistry; project: string; deviceId: string;
  selectedProfile: SelectedProfile; requestedReasoning: ReasoningEffort;
  selectedReasoning?: ReasoningEffort; requestedModel: string; instruction: string;
}): Promise<{ text: string; git: ProjectGitStatus }> {
  let snapshot: Awaited<ReturnType<typeof readProjectContextSnapshot>> | undefined;
  try { snapshot = await readProjectContextSnapshot(input.registry, input.project, input.deviceId); }
  catch (error) {
    if (!/Context source configuration unavailable/.test(String((error as Error)?.message))) throw error;
    /* Projects without documented context still receive authoritative Git state. */
  }
  const git = snapshot?.git ?? await readProjectGitStatus(input.registry, input.project, input.deviceId);
  const lines = [
    'CONTEXT CAPSULE (fresh, bounded, non-authoritative except checkout facts)',
    'CURRENT CHECKOUT STATE OVERRIDES THREAD MEMORY AND HISTORICAL DOCUMENTATION.',
    `project=${clean(input.project)} deviceId=${clean(input.deviceId)}`,
    `git branch=${clean(git.branch)} HEAD=${git.head} clean=${git.clean} staged=${git.staged} unstaged=${git.unstaged} untracked=${git.untracked}`,
    `upstream=${clean(git.upstream ?? 'none')} ahead=${git.ahead} behind=${git.behind}`,
    `documented phase=${clean(snapshot?.currentPhase ?? 'NO_VERIFICADO')} state=${clean(snapshot?.currentState ?? 'NO_VERIFICADO')}`,
    `documented nextAction=${clean(snapshot?.nextAction ?? 'NO_VERIFICADO')}`,
    `documentation warnings=${clean(snapshot?.warnings.join(',') || 'none')}`,
    `profile=${input.selectedProfile} requestedReasoning=${input.requestedReasoning} selectedReasoning=${input.selectedReasoning ?? input.requestedReasoning} requestedModel=${clean(input.requestedModel)}`,
    `instruction=${clean(input.instruction, 500)}`,
  ];
  let text = lines.join('\n');
  if (text.length > LIMIT) text = `${text.slice(0, LIMIT - 20)}\n[CAPSULE_TRUNCATED]`;
  return { text, git };
}
