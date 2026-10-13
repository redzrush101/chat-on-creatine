import { describe, expect, it } from 'vitest';

import { formatAxTree, type AxNode } from '../src/main/browser-tools/snapshot-format';

function refs() {
  const ids = new Map<number, string>();
  return (backendNodeId: number) => {
    if (!ids.has(backendNodeId)) ids.set(backendNodeId, `e${ids.size + 1}`);
    return ids.get(backendNodeId) as string;
  };
}

const tree: AxNode[] = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2', '3', '6'] },
  { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Settings' }, childIds: [] },
  { nodeId: '3', parentId: '1', role: { value: 'generic' }, childIds: ['4', '5'] },
  { nodeId: '4', parentId: '3', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 41, childIds: ['7'] },
  { nodeId: '5', parentId: '3', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'a@b.c' }, backendDOMNodeId: 42, childIds: [] },
  { nodeId: '6', parentId: '1', role: { value: 'link' }, name: { value: 'Help "center"' }, backendDOMNodeId: 43, childIds: ['8'] },
  { nodeId: '7', parentId: '4', role: { value: 'StaticText' }, name: { value: 'Save' }, childIds: [] },
  { nodeId: '8', parentId: '6', role: { value: 'StaticText' }, name: { value: 'Help center' }, childIds: [] }
];

describe('formatAxTree', () => {
  it('prints interactive elements with refs and skips duplicated static text', () => {
    const out = formatAxTree(tree, { refFor: refs(), maxLines: 100, maxChars: 10_000 });
    expect(out.text).toBe(
      [
        'RootWebArea "Page"',
        '  heading "Settings"',
        '  [ref=e1] button "Save"',
        '  [ref=e2] textbox "Email" value="a@b.c"',
        '  [ref=e3] link "Help \\"center\\""'
      ].join('\n')
    );
  });

  it('respects the line budget and reports truncation', () => {
    const out = formatAxTree(tree, { refFor: refs(), maxLines: 2, maxChars: 10_000 });
    expect(out.lineCount).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it('keeps only lines matching the filter case-insensitively', () => {
    const out = formatAxTree(tree, { refFor: refs(), maxLines: 100, maxChars: 10_000, filter: 'EMAIL' });
    expect(out.text).toBe('  [ref=e2] textbox "Email" value="a@b.c"');
  });
});
