import type { Citation, WebSource } from '@shared/types';

/**
 * ChatGPT writes inline references as private-use markers: U+E200, a kind, U+E202-separated
 * arguments, U+E201. `cite` arguments are ref ids such as `turn514763view0`; `entity` carries a
 * JSON array whose second item is the display name.
 */
const MARKER = /([a-z_]+)((?:[^]*)*)/g;
/** The unfinished marker at the end of a streaming answer. */
const PARTIAL = /[^]*$/;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function chip(sources: WebSource[]): string {
  const [first] = sources;
  if (!first) return '';
  const domains = [...new Set(sources.map((source) => source.domain))];
  const label = domains.length > 1 ? `${domains[0]} +${domains.length - 1}` : (domains[0] ?? '');
  const title = sources.map((source) => source.title || source.url).join('\n');
  return ` <a class="cite" href="${escapeHtml(first.url)}" title="${escapeHtml(title)}">${escapeHtml(label)}</a>`;
}

function entityName(argument: string): string {
  try {
    const parsed = JSON.parse(argument) as unknown;
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : '';
  } catch {
    return '';
  }
}

/**
 * The answer with its markers replaced: citations become source chips (from the answer's own
 * citations, else from the recorded search results), entities their name, anything else nothing.
 */
export function resolveMarkers(text: string, citations: Citation[] | undefined, sourcesByRef: ReadonlyMap<string, WebSource>): string {
  const byMarker = new Map((citations ?? []).map((citation) => [citation.marker, citation.sources]));
  return text
    .replace(MARKER, (marker, kind: string, rest: string) => {
      const args = rest.split('').slice(1);
      if (kind === 'entity') return escapeHtml(entityName(args[0] ?? ''));
      if (kind !== 'cite') return '';
      const sources =
        byMarker.get(marker) ?? args.map((ref) => sourcesByRef.get(ref.trim())).filter((source): source is WebSource => source !== undefined);
      return chip(sources);
    })
    .replace(PARTIAL, '');
}

/** The answer as plain text for copying: entities keep their name, every other marker goes. */
export function stripMarkers(text: string): string {
  return text
    .replace(MARKER, (_marker, kind: string, rest: string) => (kind === 'entity' ? entityName(rest.split('\ue202')[1] ?? '') : ''))
    .replace(PARTIAL, '');
}
