import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import { escapeHtml } from './format';
import { settled } from '@shared/markdown-stream';

function math(text: string, displayMode: boolean): string {
  return katex.renderToString(text, { displayMode, throwOnError: false, strict: 'ignore' });
}

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start: (src) => {
    const index = src.indexOf('$$');
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (match) return { type: 'blockMath', raw: match[0], text: (match[1] ?? '').trim() };
    return undefined;
  },
  renderer: (token) => `<div class="md-math-block">${math(String(token.text), true)}</div>`
};

// `$5 and $10` is prose: the opening $ must touch text and the closing $ must not precede a digit.
const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: (src) => {
    const index = src.indexOf('$');
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (match) return { type: 'inlineMath', raw: match[0], text: match[1] ?? '' };
    return undefined;
  },
  renderer: (token) => math(String(token.text), false)
};

const markdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  extensions: [blockMath, inlineMath],
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      const body = language ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
      const label = escapeHtml(language ?? lang ?? 'text');
      return (
        `<div class="md-code"><div class="md-code-head"><span>${label}</span>` +
        `<button type="button" class="md-copy" data-copy aria-label="Copy code">Copy</button></div>` +
        `<pre><code class="hljs">${body}</code></pre></div>`
      );
    },
    image({ text }) {
      return `<span class="md-image-alt">${escapeHtml(text || 'image')}</span>`;
    }
  }
});

// Links leave the app through the main process; the click handler lives in the timeline.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement && /^(https?:|mailto:)/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('data-external', '');
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('target', '_blank');
  } else if (node instanceof HTMLAnchorElement) {
    node.removeAttribute('href');
  }
});

/** Markdown from the model rendered to HTML that is safe to inject. */
export function renderMarkdown(source: string): string {
  const html = markdown.parse(source, { async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true, svg: true } });
}

/** Reuse completed blocks while streaming; a final render resolves cross-block references. */
export function streamingMarkdown(): (source: string, streaming: boolean) => string[] {
  let committed = '';
  let blocks: string[] = [];
  return (source, streaming) => {
    if (!streaming) return [renderMarkdown(source)];
    if (!source.startsWith(committed)) { committed = ''; blocks = []; }
    const pending = source.slice(committed.length);
    const end = settled(pending);
    if (end) {
      const block = pending.slice(0, end);
      blocks.push(renderMarkdown(block));
      committed += block;
    }
    return [...blocks, renderMarkdown(source.slice(committed.length))];
  };
}
