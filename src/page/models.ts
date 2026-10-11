import type { ReasoningEffort } from '@shared/config';
import type { ModelsValue } from '@shared/page-protocol';

/** Backend thinking-effort names mapped onto the app's reasoning efforts. */
const EFFORT_NAMES: Record<string, ReasoningEffort> = {
  light: 'low',
  standard: 'medium',
  extended: 'high',
  heavy: 'xhigh',
  max: 'xhigh'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseModels(body: unknown): ModelsValue {
  const root = isRecord(body) ? body : {};
  const list = (Array.isArray(root.models) ? root.models : []).filter(isRecord);
  const models = list.flatMap((model) => {
    const id = typeof model.slug === 'string' ? model.slug : null;
    if (!id) return [];
    const label = typeof model.title === 'string' ? model.title : id;
    const efforts: ReasoningEffort[] = [];
    if (model.reasoning_type !== 'none' && Array.isArray(model.thinking_efforts)) {
      for (const entry of model.thinking_efforts) {
        const name = isRecord(entry) && typeof entry.thinking_effort === 'string' ? entry.thinking_effort : null;
        const effort = name ? EFFORT_NAMES[name] : undefined;
        if (effort && !efforts.includes(effort)) efforts.push(effort);
      }
    }
    return [{ id, label, efforts }];
  });
  const fallback = list.find((model) => model.is_default === true);
  const defaultModel =
    typeof root.default_model_slug === 'string'
      ? root.default_model_slug
      : typeof fallback?.slug === 'string'
        ? fallback.slug
        : null;
  return { defaultModel, models };
}

