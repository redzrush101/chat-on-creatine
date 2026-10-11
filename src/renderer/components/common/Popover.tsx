import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { cx } from '../../lib/format';

interface PopoverTrigger {
  open: boolean;
  toggle(): void;
}

interface PopoverProps {
  trigger(state: PopoverTrigger): ReactNode;
  /** Panel content; receives `close` for actions that should dismiss the panel. */
  children(close: () => void): ReactNode;
  align?: 'start' | 'end';
  panelClassName?: string;
  label?: string;
}

/** A trigger with a floating panel. Closes on outside click, Escape and close actions. */
export function Popover({ trigger, children, align = 'start', panelClassName, label }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    const first = panel.current?.querySelector<HTMLElement>('button:not(:disabled), input, select, textarea');
    first?.focus();
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div
      className="popover-anchor"
      ref={anchor}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div
          ref={panel}
          className={cx('popover-panel', `is-${align}`, panelClassName)}
          role="dialog"
          aria-label={label}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: LucideIcon; onSelect(): void; danger?: boolean; disabled?: boolean; checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

interface MenuListProps {
  entries: MenuEntry[];
  onClose(): void;
}

/** Keyboard-navigable menu list (arrows, Home/End; Enter or Space activates; Escape closes via the anchor). */
export function MenuList({ entries, onClose }: MenuListProps) {
  const list = useRef<HTMLDivElement>(null);
  const menuItems = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  useEffect(() => {
    menuItems()[0]?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  };

  return (
    <div ref={list} className="menu" role="menu" onKeyDown={onKeyDown}>
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') return <div key={index} className="menu-separator" role="separator" />;
        if (entry.kind === 'label') return <div key={index} className="menu-label">{entry.label}</div>;
        const Icon = entry.icon;
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={cx('menu-item', entry.danger && 'is-danger', entry.checked && 'is-checked')}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span className="menu-icon" aria-hidden="true">{Icon ? <Icon size={14} /> : null}</span>
            <span className="menu-text">{entry.label}</span>
            {entry.checked && <Check size={14} className="menu-check" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

interface MenuButtonProps {
  entries: MenuEntry[];
  label: string;
  icon: LucideIcon;
  className?: string;
  align?: 'start' | 'end';
}

/** Icon button that opens a MenuList. */
export function MenuButton({ entries, label, icon: Icon, className, align = 'end' }: MenuButtonProps) {
  return (
    <Popover
      label={label}
      align={align}
      panelClassName="is-menu"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={cx('icon-btn', className)}
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          <Icon size={15} />
        </button>
      )}
    >
      {(close) => <MenuList entries={entries} onClose={close} />}
    </Popover>
  );
}
