import type { ThinkingLevel } from '@/types/api'

export type ProviderId = 'openai' | 'openrouter' | 'gemini' | 'ollama'
type ThinkingProfile = 'standard' | 'binary' | 'discrete-no-off'

export interface ModelOption {
  id: string
  provider: ProviderId
  label: string
  thinkingProfile: ThinkingProfile
}

export interface ThinkingOption {
  value: ThinkingLevel
  label: string
}

export const DEFAULT_MODEL_ID = 'openai/gpt-5.4-mini'
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'off'

export const PROVIDER_OPTIONS: Array<{ id: ProviderId; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'ollama', label: 'Ollama' },
]

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'openai/gpt-5.4-mini', provider: 'openai', label: 'GPT-5.4 Mini', thinkingProfile: 'standard' },
  { id: 'openai/gpt-5.4-nano', provider: 'openai', label: 'GPT-5.4 Nano', thinkingProfile: 'standard' },
  { id: 'openrouter/qwen/qwen3.6-plus', provider: 'openrouter', label: 'Qwen 3.6 Plus', thinkingProfile: 'binary' },
  { id: 'openrouter/z-ai/glm-5.1:nitro', provider: 'openrouter', label: 'GLM 5.1 Nitro', thinkingProfile: 'binary' },
  { id: 'openrouter/moonshotai/kimi-k2.5:nitro', provider: 'openrouter', label: 'Kimi K2.5 Nitro', thinkingProfile: 'binary' },
  { id: 'openrouter/x-ai/grok-4.20', provider: 'openrouter', label: 'Grok 4.20', thinkingProfile: 'binary' },
  { id: 'openrouter/minimax/minimax-m2.7:nitro', provider: 'openrouter', label: 'MiniMax M2.7 Nitro', thinkingProfile: 'binary' },
  { id: 'gemini/gemini-3-flash-preview', provider: 'gemini', label: 'Gemini 3 Flash Preview', thinkingProfile: 'standard' },
  { id: 'gemini/gemini-3.1-pro-preview', provider: 'gemini', label: 'Gemini 3.1 Pro Preview', thinkingProfile: 'standard' },
  { id: 'ollama/gemma4:31b-cloud', provider: 'ollama', label: 'Gemma 4 31B Cloud', thinkingProfile: 'binary' },
  { id: 'ollama/gpt-oss:120b-cloud', provider: 'ollama', label: 'GPT-OSS 120B Cloud', thinkingProfile: 'discrete-no-off' },
]

export function getProviderForModel(modelId: string): ProviderId {
  return getModelOption(modelId).provider
}

export function getModelOption(modelId: string): ModelOption {
  return MODEL_OPTIONS.find((option) => option.id === modelId) ?? MODEL_OPTIONS[0]
}

export function getModelsForProvider(provider: ProviderId): ModelOption[] {
  return MODEL_OPTIONS.filter((option) => option.provider === provider)
}

export function normalizeThinkingLevelForModel(modelId: string, value: ThinkingLevel): ThinkingLevel {
  const model = getModelOption(modelId)

  if (model.thinkingProfile === 'standard') {
    return value
  }

  if (model.thinkingProfile === 'binary') {
    return value === 'off' ? 'off' : 'low'
  }

  return value === 'off' ? 'low' : value
}

export function getThinkingOptionsForModel(modelId: string): ThinkingOption[] {
  const model = getModelOption(modelId)

  if (model.thinkingProfile === 'binary') {
    return [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'On' },
    ]
  }

  if (model.thinkingProfile === 'discrete-no-off') {
    return [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ]
  }

  return [
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ]
}

export function getThinkingLabelForModel(modelId: string, value: ThinkingLevel): string {
  return getThinkingOptionsForModel(modelId).find((option) => option.value === value)?.label ?? value
}