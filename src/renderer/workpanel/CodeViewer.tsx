import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { basicSetup } from 'codemirror';

type LanguageEntry = (typeof languages)[number];

/** Picks a language by exact filename first (Dockerfile, Makefile), then by extension. */
function languageFor(name: string): LanguageEntry | null {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return languages.find((entry) => entry.filename?.test(name)) ?? languages.find((entry) => entry.extensions.includes(extension)) ?? null;
}

const syntax = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--code-inline)' },
  { tag: [tags.typeName, tags.className, tags.propertyName], color: 'var(--accent)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--link)' },
  { tag: [tags.string, tags.regexp], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warning)' },
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' }
]));

/** Read-only view of one file. Highlighting follows the app theme; the surface uses the design tokens. */
export function CodeViewer({ name, text }: { name: string; text: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          syntax,
          language.of([]),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'var(--bg-code)', color: 'var(--text)', fontSize: 'var(--text-xs)' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)' },
            '.cm-gutters': { backgroundColor: 'var(--bg-code)', color: 'var(--text-faint)', border: 'none' },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
            '.cm-selectionBackground, .cm-searchMatch': { backgroundColor: 'var(--accent-soft)' }
          })
        ]
      })
    });

    let cancelled = false;
    const entry = languageFor(name);
    if (entry) {
      void entry.load().then((support) => {
        if (!cancelled) view.dispatch({ effects: language.reconfigure(support) });
      });
    }

    return () => {
      cancelled = true;
      view.destroy();
    };
  }, [name, text]);

  return <div className="wp-code" ref={hostRef} />;
}
