import type { KeyboardEvent, PointerEvent } from 'react';

interface ResizerProps {
  side: 'left' | 'right';
  label: string;
  width: number;
  onPointerDown(event: PointerEvent<HTMLDivElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onReset(): void;
}

/** Vertical drag handle on a panel edge; arrow keys resize, double-click resets. */
export function Resizer({ side, label, width, onPointerDown, onKeyDown, onReset }: ResizerProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      title={`${label}. Drag, arrow keys to adjust, double-click to reset`}
      className={`resizer is-${side}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
