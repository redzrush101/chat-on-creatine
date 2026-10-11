import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface InlineEditProps {
  value: string;
  label: string;
  className?: string;
  onCommit(text: string): void;
  onCancel(): void;
}

/** Text field that replaces a label in place. Enter or blur saves, Escape discards. */
export function InlineEdit({ value, label, className, onCommit, onCancel }: InlineEditProps) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = text.trim();
    if (next && next !== value) onCommit(next);
    else onCancel();
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') commit();
    else if (event.key === 'Escape') cancel();
  };

  return (
    <input
      ref={input}
      className={className ?? 'inline-edit'}
      aria-label={label}
      value={text}
      autoFocus
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
    />
  );
}
