export type RequestedProfile = 'auto' | 'fast' | 'standard' | 'deep' | 'exceptional';
export type SelectedProfile = Exclude<RequestedProfile, 'auto'>;
export type ExecutionCategory = 'simple' | 'implementation' | 'debugging' | 'security' | 'architecture' | 'migration' | 'concurrency' | 'recovery';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

const deepCategories = new Set<ExecutionCategory>(['security', 'architecture', 'migration', 'concurrency', 'recovery']);

export function resolveExecutionProfile(input: {
  requested?: RequestedProfile;
  operation: 'analysis' | 'prepare' | 'apply';
  category?: ExecutionCategory;
  instruction: string;
  supportedEfforts?: string[];
}): { requestedProfile: RequestedProfile; profile: SelectedProfile; reasoning: ReasoningEffort; fallback: boolean } {
  const requestedProfile = input.requested ?? 'auto';
  let profile: SelectedProfile;
  if (requestedProfile !== 'auto') profile = requestedProfile;
  else if (input.category && deepCategories.has(input.category)) profile = 'deep';
  else profile = input.operation === 'analysis' ? 'fast' : 'standard';
  const preferred: ReasoningEffort = profile === 'fast' ? 'low' : profile === 'standard' ? 'medium' : profile === 'deep' ? 'high' : 'xhigh';
  const supported = input.supportedEfforts ?? ['low', 'medium', 'high', 'xhigh'];
  const reasoning: ReasoningEffort = supported.includes(preferred) ? preferred :
    profile === 'exceptional' && supported.includes('high') ? 'high' :
    supported.includes('medium') ? 'medium' : supported.includes('low') ? 'low' : 'high';
  return { requestedProfile, profile, reasoning, fallback: reasoning !== preferred };
}

export function isRequestedProfile(value: unknown): value is RequestedProfile {
  return ['auto', 'fast', 'standard', 'deep', 'exceptional'].includes(String(value));
}

export function isExecutionCategory(value: unknown): value is ExecutionCategory {
  return ['simple', 'implementation', 'debugging', 'security', 'architecture', 'migration', 'concurrency', 'recovery'].includes(String(value));
}
