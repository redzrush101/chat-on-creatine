/** Pure formatting of a CDP Accessibility tree into compact text with stable element refs. */

export interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
}

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider',
  'spinbutton', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem'
]);

/** Roles that only group content; their children are printed at the same depth. */
const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation']);

const MAX_NAME_CHARS = 200;

export interface SnapshotOptions {
  /** Returns the ref for a DOM node, assigning a new one the first time the node is seen. */
  refFor: (backendNodeId: number) => string;
  maxLines: number;
  maxChars: number;
  /** Literal, case-insensitive substring; only matching lines are kept. */
  filter?: string;
}

export interface SnapshotText {
  text: string;
  lineCount: number;
  truncated: boolean;
}

function clean(value: unknown, limit = MAX_NAME_CHARS): string {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Formats one node line; `null` when the node carries nothing worth printing. */
function describe(node: AxNode, role: string, refFor: SnapshotOptions['refFor']): string | null {
  const name = clean(node.name?.value);
  const value = node.value?.value === undefined ? '' : clean(node.value.value);
  const interactive = INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined;
  if (!interactive && role !== 'StaticText' && !name && !value) return null;
  if (role === 'StaticText') return name ? JSON.stringify(name) : null;
  const ref = interactive ? `[ref=${refFor(node.backendDOMNodeId as number)}] ` : '';
  const label = name ? ` ${JSON.stringify(name)}` : '';
  const shown = value && value !== name ? ` value=${JSON.stringify(value)}` : '';
  return `${ref}${role}${label}${shown}`;
}

/**
 * Walks the tree depth-first from its root. Ignored and structural nodes are transparent,
 * so their children keep the depth of the nearest printed ancestor.
 */
export function formatAxTree(nodes: AxNode[], options: SnapshotOptions): SnapshotText {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  const filter = options.filter?.toLowerCase();

  const emit = (line: string, depth: number): void => {
    if (filter && !line.toLowerCase().includes(filter)) return;
    if (lines.length >= options.maxLines || chars >= options.maxChars) {
      truncated = true;
      return;
    }
    const full = `${'  '.repeat(Math.min(depth, 20))}${line}`;
    lines.push(full);
    chars += full.length + 1;
  };

  // A named control already states its text, so its StaticText children would repeat it.
  const visit = (node: AxNode, depth: number, textSettled: boolean): void => {
    if (truncated) return;
    const role = String(node.role?.value ?? '');
    if (role === 'StaticText' && textSettled) return;
    const transparent = node.ignored || STRUCTURAL_ROLES.has(role);
    let childDepth = depth;
    let childSettled = textSettled;
    if (!transparent) {
      const line = describe(node, role, options.refFor);
      if (line !== null) {
        emit(line, depth);
        childDepth = depth + 1;
        childSettled = textSettled || (INTERACTIVE_ROLES.has(role) && clean(node.name?.value) !== '');
      }
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, childDepth, childSettled);
    }
  };

  if (root) visit(root, 0, false);
  return { text: lines.join('\n'), lineCount: lines.length, truncated };
}
