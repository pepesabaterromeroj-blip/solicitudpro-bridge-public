import type { ReasoningEffort } from './execution-profile.js';

type Client = { request<T = any>(method: string, params?: unknown): Promise<T> };
export interface RuntimeSelection {
  requestedModel: string; requestedReasoning: ReasoningEffort;
  runtimeModel: string; runtimeReasoning: string; modelOverride?: string;
  reasoning: ReasoningEffort; fallback: boolean;
}

export async function selectCodexRuntime(client: Client, cwd: string, configuredModel: string | null | undefined, preferredReasoning: ReasoningEffort): Promise<RuntimeSelection> {
  let config: any = {}, data: any[] = [];
  try {
    const [configuration, catalog] = await Promise.all([
      client.request<any>('config/read', { includeLayers: false, cwd }),
      client.request<any>('model/list', {}),
    ]);
    config = configuration?.config ?? {}; data = Array.isArray(catalog?.data) ? catalog.data : [];
  } catch { /* Older runtimes retain safe configured defaults. */ }
  const activeModel = typeof config.model === 'string' ? config.model : undefined;
  const requested = configuredModel || activeModel;
  const entry = requested ? data.find(model => model?.id === requested || model?.model === requested) : undefined;
  const efforts = Array.isArray(entry?.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.map((item: any) => item?.reasoningEffort).filter((value: any) => typeof value === 'string') : ['low', 'medium', 'high'];
  const reasoning: ReasoningEffort = efforts.includes(preferredReasoning) ? preferredReasoning : preferredReasoning === 'xhigh' && efforts.includes('high') ? 'high' : efforts.includes('medium') ? 'medium' : 'low';
  return {
    requestedModel: requested || 'NO_VERIFICADO', requestedReasoning: preferredReasoning,
    runtimeModel: configuredModel && entry ? configuredModel : activeModel || 'NO_VERIFICADO', runtimeReasoning: typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : 'NO_VERIFICADO',
    modelOverride: configuredModel && entry ? configuredModel : undefined, reasoning, fallback: reasoning !== preferredReasoning || Boolean(configuredModel && !entry),
  };
}

export async function observeThreadRuntime(client: Client, threadId: string, fallback: RuntimeSelection): Promise<Pick<RuntimeSelection, 'runtimeModel' | 'runtimeReasoning'>> {
  try {
    const response = await client.request<any>('thread/read', { threadId, includeTurns: false });
    return {
      runtimeModel: typeof response?.thread?.model === 'string' ? response.thread.model : fallback.runtimeModel,
      runtimeReasoning: typeof response?.thread?.reasoningEffort === 'string' ? response.thread.reasoningEffort : fallback.runtimeReasoning,
    };
  } catch { return { runtimeModel: fallback.runtimeModel, runtimeReasoning: 'NO_VERIFICADO' }; }
}
