import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { languages } from '@codemirror/language-data';
import { basicSetup } from 'codemirror';

type LanguageEntry = (typeof languages)[number];

/** Picks a language by exact filename first (Dockerfile, Makefile), then by extension. */
function languageFor(name: string): LanguageEntry | null {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return languages.find((entry) => entry.filename?.test(name)) ?? languages.find((entry) => entry.extensions.includes(extension)) ?? null;
}

// Tokens default to dark; the app marks light mode with data-theme="light" on the root.
function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme !== 'light';
}

/** Read-only view of one file. Highlighting follows the app theme; the surface uses the design tokens. */
export function CodeViewer({ name, text }: { name: string; text: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const theme = new Compartment();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          theme.of(isDarkTheme() ? oneDark : []),
          language.of([]),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'var(--bg-code)', color: 'var(--text)', fontSize: 'var(--text-xs)' },
            '.cm-scroller': { fontFamily: 'var(--font-mono)' },
            '.cm-gutters': { backgroundColor: 'var(--bg-code)', color: 'var(--text-faint)', border: 'none' }
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
