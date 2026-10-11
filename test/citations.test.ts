import { describe, expect, it } from 'vitest';
import type { WebSource } from '@shared/types';
import { resolveMarkers, stripMarkers } from '../src/renderer/lib/citations';

const changelog: WebSource = { title: 'ChangeLog-7.2.10', url: 'https://cdn.kernel.org/ChangeLog-7.2.10', domain: 'cdn.kernel.org', ref: 'turn514763view0' };
const cite = (...refs: string[]) => `cite${refs.join('')}`;

describe('citation markers', () => {
  it('uses the answer citations first, then the recorded search results', () => {
    const own = { marker: cite('turn1search0'), sources: [{ ...changelog, domain: 'Kernel.org', ref: null }] };
    expect(resolveMarkers(`A. ${cite('turn1search0')}`, [own], new Map())).toContain('>Kernel.org</a>');
    expect(resolveMarkers(`B. ${cite('turn514763view0')}`, undefined, new Map([[changelog.ref!, changelog]]))).toContain(
      '<a class="cite" href="https://cdn.kernel.org/ChangeLog-7.2.10"'
    );
  });

  it('drops markers it cannot resolve, unknown kinds and the unfinished tail of a stream', () => {
    expect(resolveMarkers(`C. ${cite('turn9search9')}`, undefined, new Map())).toBe('C. ');
    expect(resolveMarkers('D. navlistx', undefined, new Map())).toBe('D. ');
    expect(resolveMarkers('E. citeturn51', undefined, new Map())).toBe('E. ');
  });

  it('keeps entity names, in chips and in copied text', () => {
    const entity = 'entity["software","Linux kernel",""]';
    expect(resolveMarkers(`The ${entity} ships`, undefined, new Map())).toBe('The Linux kernel ships');
    expect(stripMarkers(`The ${entity} ships ${cite('turn1search0')}`)).toBe('The Linux kernel ships ');
  });
});
