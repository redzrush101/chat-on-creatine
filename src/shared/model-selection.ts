import type { ReasoningEffort } from './config';
import type { ModelOption, ModelSelection } from './types';

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  pro: 'Pro'
};

/** Resolves a concrete conversation slug to its visible picker family. */
export function findModel(models: ModelOption[], id: string | null): ModelOption | undefined {
  return models.find((model) => model.id === id || (id !== null && model.slugs?.includes(id)));
}

/** Converts a family and effort into the concrete model that ChatGPT sends. */
export function modelSelection(option: ModelOption, reasoning: ReasoningEffort | null): ModelSelection {
  const preset = option.presets?.find((entry) => entry.reasoning === reasoning)
    ?? option.presets?.find((entry) => entry.model === option.id);
  return preset
    ? { model: preset.model, reasoning: preset.reasoning }
    : { model: option.id, reasoning: reasoning && option.efforts.includes(reasoning) ? reasoning : null };
}

/** What ChatGPT's picker calls an effort: the model's own preset name, else the generic one. */
export function effortLabel(option: ModelOption | undefined, effort: ReasoningEffort): string {
  return option?.presets?.find((preset) => preset.reasoning === effort)?.label ?? EFFORT_LABEL[effort];
}
