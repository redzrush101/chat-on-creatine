import type { ReasoningEffort } from '@shared/config';
import type { ModelsValue } from '@shared/page-protocol';
import type { ModelOption, ModelPreset } from '@shared/types';
import { findModel } from '@shared/model-selection';

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
  const details = new Map(list.flatMap((model): [string, Record<string, unknown>][] =>
    typeof model.slug === 'string' && model.slug ? [[model.slug, model]] : []));
  const fallback = list.find((model) => model.is_default === true);
  const defaultSlug = typeof root.default_model_slug === 'string' ? root.default_model_slug
    : typeof fallback?.slug === 'string' ? fallback.slug : null;

  // The raw models array includes Work, research and fallback lanes absent from the picker.
  const models: ModelOption[] = Array.isArray(root.versions)
    ? root.versions.filter(isRecord).flatMap((version) => {
      if (version.enabled !== true || !Array.isArray(version.intelligence_presets)) return [];
      const presets = version.intelligence_presets.flatMap((entry, index): ModelPreset[] => {
        if (!isRecord(entry) || entry.preset_type !== 'available' || typeof entry.model_slug !== 'string'
          || !details.has(entry.model_slug)) return [];
        const reasoning = entry.lane === 'instant' ? 'none'
          : typeof entry.thinking_effort === 'string' ? EFFORT_NAMES[entry.thinking_effort] : undefined;
        if (!reasoning || typeof entry.title !== 'string') return [];
        return [{ model: entry.model_slug, reasoning, label: entry.title, index }];
      });
      const primary = presets.find((preset) => preset.reasoning === 'medium') ?? presets[0];
      if (!primary) return [];
      const label = typeof version.display_text_for_intelligence === 'string' ? version.display_text_for_intelligence
        : typeof version.display_text === 'string' ? version.display_text : null;
      if (!label) return [];
      const slugs = [...new Set(presets.map((preset) => preset.model))];
      if (defaultSlug && Array.isArray(version.slugs) && version.slugs.includes(defaultSlug) && !slugs.includes(defaultSlug)) {
        slugs.push(defaultSlug);
      }
      return [{ id: primary.model, label, efforts: [...new Set(presets.map((preset) => preset.reasoning))], slugs, presets }];
    })
    : (Array.isArray(root.categories) ? root.categories : []).filter(isRecord).flatMap((category) => {
    const model = typeof category.default_model === 'string' ? details.get(category.default_model) : undefined;
    if (!model) return [];
    const id = typeof model.slug === 'string' ? model.slug : null;
    if (!id) return [];
    const label = typeof category.human_category_short_name === 'string' ? category.human_category_short_name
      : typeof model.title === 'string' ? model.title : id;
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
  return { defaultModel: findModel(models, defaultSlug) ? defaultSlug : null, models };
}

