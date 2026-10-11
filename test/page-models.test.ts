import { describe, expect, it } from 'vitest';
import { parseModels } from '../src/page/models';

describe('ChatGPT model catalog parser', () => {
  it('normalizes efforts, drops unknown efforts and keeps distinct slugs', () => {
    const result = parseModels({ default_model_slug: 'thinking', categories: [
      { default_model: 'thinking' }, { default_model: 'fast' }
    ], models: [
      { slug: 'thinking', title: 'Thinking', thinking_efforts: [{ thinking_effort: 'heavy' }, { thinking_effort: 'max' }, { thinking_effort: 'future' }, { thinking_effort: 'light' }] },
      { slug: 'fast', reasoning_type: 'none', thinking_efforts: [{ thinking_effort: 'light' }] },
      { title: 'Missing slug' }, null
    ] });
    expect(result).toEqual({ defaultModel: 'thinking', models: [
      { id: 'thinking', label: 'Thinking', efforts: ['xhigh', 'low'] },
      { id: 'fast', label: 'fast', efforts: [] }
    ] });
  });

  it('uses the flagged default when the root has no default slug', () => {
    expect(parseModels({ categories: [{ default_model: 'default' }], models: [{ slug: 'default', is_default: true }] }).defaultModel).toBe('default');
  });

  it('uses enabled picker families and available presets rather than internal backend models', () => {
    const result = parseModels({ default_model_slug: 'auto', models: [
      { slug: 'auto' }, { slug: 'instant' }, { slug: 'thinking' }, { slug: 'work' }, { slug: 'research' }
    ], versions: [
      { enabled: true, display_text_for_intelligence: 'Current', slugs: ['auto', 'instant', 'thinking'], intelligence_presets: [
        { model_slug: 'instant', lane: 'instant', title: 'Instant', preset_type: 'available' },
        { model_slug: 'thinking', lane: 'thinking', thinking_effort: 'standard', title: 'Medium', preset_type: 'available' },
        { model_slug: 'thinking', lane: 'thinking', thinking_effort: 'extended', title: 'High', preset_type: 'available' },
        { model_slug: 'work', title: 'Pro', preset_type: 'locked' }
      ] },
      { enabled: false, display_text: 'Disabled', intelligence_presets: [
        { model_slug: 'work', lane: 'instant', title: 'Instant', preset_type: 'available' }
      ] }
    ] });
    expect(result).toEqual({ defaultModel: 'auto', models: [{ id: 'thinking', label: 'Current',
      efforts: ['none', 'medium', 'high'], slugs: ['instant', 'thinking', 'auto'], presets: [
        { model: 'instant', reasoning: 'none', label: 'Instant', index: 0 },
        { model: 'thinking', reasoning: 'medium', label: 'Medium', index: 1 },
        { model: 'thinking', reasoning: 'high', label: 'High', index: 2 }
      ] }] });
  });

  it('keeps native slider positions when a preset is locked, missing or unknown', () => {
    const result = parseModels({ models: [{ slug: 'thinking' }], versions: [
      { enabled: true, display_text: 'Legacy', intelligence_presets: [
        { model_slug: 'thinking', lane: 'thinking', thinking_effort: 'light', title: 'Locked', preset_type: 'locked' },
        { model_slug: 'missing', lane: 'instant', title: 'Missing', preset_type: 'available' },
        { model_slug: 'thinking', lane: 'thinking', thinking_effort: 'future', title: 'Unknown', preset_type: 'available' },
        { model_slug: 'thinking', lane: 'thinking', thinking_effort: 'extended', title: 'High', preset_type: 'available' }
      ] }
    ] });
    expect(result.models[0]?.presets).toEqual([{ model: 'thinking', reasoning: 'high', label: 'High', index: 3 }]);
  });

  it.each([{ models: [{ slug: 'internal', is_default: true }] },
    { versions: [], categories: [{ default_model: 'internal' }], models: [{ slug: 'internal' }] },
    { categories: [{ default_model: 'missing' }], default_model_slug: 'internal', models: [{ slug: 'internal' }] }
  ])('does not expose unadvertised models or defaults: %j', (body) => {
    expect(parseModels(body)).toEqual({ defaultModel: null, models: [] });
  });

  it.each([null, [], { models: 'invalid' }])('accepts an absent or malformed catalog: %j', (body) => {
    expect(parseModels(body)).toEqual({ defaultModel: null, models: [] });
  });
});
