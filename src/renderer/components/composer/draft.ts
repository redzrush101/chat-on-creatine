import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const MAX_INPUT_HEIGHT = 240;

function draftKey(sessionId: string | null): string {
  return `creatine.draft.${sessionId ?? 'new'}`;
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the draft lives only until the composer unmounts.
  }
}

export function useComposerDraft(sessionId: string | null, focusNonce: number, prefill?: { id: number; text: string }) {
  const key = draftKey(sessionId);
  const [text, setText] = useState(() => readDraft(key));
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    writeDraft(key, text);
  }, [key, text]);

  useEffect(() => {
    field.current?.focus();
  }, [focusNonce]);

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    field.current?.focus();
  }, [prefill]);

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);

  const clearSent = (sent: string) => {
    if ((field.current?.value ?? readDraft(key)) !== sent) return;
    writeDraft(key, '');
    setText('');
  };

  return { text, setText, field, clearSent };
}
