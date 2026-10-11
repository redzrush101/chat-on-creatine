import { describe, expect, it } from 'vitest';
import { parseModels } from '../src/page/models';

describe('ChatGPT model catalog parser', () => {
  it('normalizes efforts, drops unknown efforts and keeps distinct slugs', () => {
    const result = parseModels({ default_model_slug: 'thinking', models: [
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
    expect(parseModels({ models: [{ slug: 'default', is_default: true }] }).defaultModel).toBe('default');
  });

  it.each([null, [], { models: 'invalid' }])('accepts an absent or malformed catalog: %j', (body) => {
    expect(parseModels(body)).toEqual({ defaultModel: null, models: [] });
  });
});
