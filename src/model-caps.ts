export type EffortName = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const ALL_EFFORTS: readonly EffortName[] = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type EffortSupport =
  | { known: true; efforts: readonly EffortName[] }
  | { known: false };

const FULL: readonly EffortName[] = ALL_EFFORTS;

export const MODEL_EFFORTS: Readonly<Record<string, readonly EffortName[]>> = {
  'deepseek/deepseek-v4-pro': ['off', 'high', 'max'],
  'deepseek/deepseek-v4-flash': ['off', 'high', 'max'],
  'deepseek/deepseek-v4-flash-vision-exp': ['off', 'high', 'max'],
  'deepseek/deepseek-v4-flash-fast': ['low', 'high', 'max'],
  'deepseek/deepseek-v4.1-flash': ['off', 'low', 'high', 'max'],
  'deepseek/deepseek-v4.1-flash-fast': ['off', 'low', 'high', 'max'],
  'moonshotai/Kimi-K3': ['low', 'high', 'max'],
  'moonshotai/Kimi-K2.7-Code': [],
  'moonshotai/Kimi-K2.7-Code-Highspeed': [],
  'moonshotai/Kimi-K2.6': [],
  'moonshotai/Kimi-K2.5': [],
  'z-ai/glm-5.3-flash': ['low', 'high', 'max'],
  'z-ai/glm-5.3-flashx': ['low', 'high', 'max'],
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': ['high', 'max'],
  'zai-org/GLM-5.2-Fast': [],
  'zai-org/GLM-5.1': [],
  'zai-org/GLM-5': [],
  'MiniMaxAI/MiniMax-M3': ['low', 'medium', 'high'],
  'MiniMaxAI/MiniMax-M2.7': [],
  'MiniMaxAI/MiniMax-M2.5': [],
  'xiaomi/mimo-v2.6-pro': [],
  'xiaomi/mimo-v2.6-pro-ultraspeed': [],
  'xiaomi/mimo-v2.6-flash': [],
  'xiaomi/mimo-v2.5-pro': [],
  'xiaomi/mimo-v2.5': [],
  'Qwen/Qwen3.8-Omni-Flash': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max-0902': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-27B': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.8-Flash': ['low', 'medium', 'xhigh'],
  'Qwen/Qwen3.7-Max': [],
  'Qwen/Qwen3.7-Plus': [],
  'Qwen/Qwen3.7-Flash': [],
  'Qwen/Qwen3.6-Max-Preview': [],
  'Qwen/Qwen3.6-Plus': [],
  'meituan/LongCat-2.0': [],
  'stepfun/Step-5-Preview': ['low', 'medium', 'high'],
  'stepfun/Step-3.7-Flash': [],
  'stepfun/Step-3.5-Flash': [],
  'tencent/hy3-paid': [],
  'tencent/hy4-preview': ['low', 'medium', 'high'],
  'nvidia/nemotron-3-ultra-550b-a55b': [],
  'thinkingmachines/inkling': [],
  'thinkingmachines/inkling-small': [],
  'poolside/laguna-s-2.1-free': [],
  'inclusionai/ling-3.0-flash-sante:free': [],
  'inclusionai/ling-3.1-flash:free': ['low', 'medium', 'high'],
  'stealth/space-bunny-alpha': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-5-5': FULL,
  'claude-sonnet-5': FULL,
  'claude-sonnet-4-6': FULL,
  'claude-fable-5-1': FULL,
  'claude-fable-5': FULL,
  'claude-opus-5-5': FULL,
  'claude-opus-5': FULL,
  'claude-opus-4-8': FULL,
  'claude-opus-4-7': FULL,
  'claude-haiku-4-5-20251001': [],
  'gpt-6-astra': FULL,
  'gpt-6.1-sol': FULL,
  'gpt-6-sol': FULL,
  'gpt-6-luna': FULL,
  'gpt-5.6-sol': FULL,
  'gpt-5.6-terra': FULL,
  'gpt-5.6-luna': FULL,
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'google/gemini-3.8-flash': ['low', 'medium', 'high'],
  'google/gemini-3.7-flash': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'meta/muse-spark-1.1': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.2-contributor': ['low', 'medium', 'high', 'xhigh'],
  'meta/muse-spark-1.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  'meta/muse-spark-1.3-contributor': ['low', 'medium', 'high', 'xhigh'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'xai/grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'xai/grok-4.7': ['low', 'medium', 'high', 'xhigh'],
};

export function effortsFor(modelId: string | null): EffortSupport {
  if (modelId === null || modelId === '') return { known: false };
  const efforts = MODEL_EFFORTS[modelId];
  if (efforts === undefined) return { known: false };
  return { known: true, efforts };
}

export function isEffortSupported(modelId: string | null, effort: string): boolean {
  const support = effortsFor(modelId);
  if (!support.known) return true;
  return (support.efforts as readonly string[]).includes(effort);
}

export interface EffectiveEffort {
  effort: string | null;
  clearStored: boolean;
  reason: 'stored' | 'default' | 'none' | 'stored-unsupported' | 'default-unsupported';
}

export function effectiveEffort(
  modelId: string | null,
  storedEffort: string | null,
  defaultEffort: string | null,
): EffectiveEffort {
  if (storedEffort !== null) {
    if (isEffortSupported(modelId, storedEffort)) {
      return { effort: storedEffort, clearStored: false, reason: 'stored' };
    }
    return { effort: null, clearStored: true, reason: 'stored-unsupported' };
  }
  if (defaultEffort !== null) {
    if (isEffortSupported(modelId, defaultEffort)) {
      return { effort: defaultEffort, clearStored: false, reason: 'default' };
    }
    return { effort: null, clearStored: false, reason: 'default-unsupported' };
  }
  return { effort: null, clearStored: false, reason: 'none' };
}
