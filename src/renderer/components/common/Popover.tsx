import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
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

/** Gap between the trigger and the panel, and the least space kept from any viewport edge. */
const GAP = 6;
const MARGIN = 8;

interface Placement {
  left: number;
  /** Set when the panel opens below the trigger. */
  top?: number;
  /** Set when the panel opens above the trigger, so it grows upward from the trigger. */
  bottom?: number;
  maxHeight: number;
}

interface Box {
  width: number;
  height: number;
}

/**
 * Places a panel of `panel` size next to `anchor` inside a viewport. It opens downward when that fits,
 * upward otherwise, and shrinks to the larger side (scrolling internally) when neither side fits.
 */
export function placeFloating(anchor: DOMRect, panel: Box, align: 'start' | 'end', viewport: Box): Placement {
  const spaceBelow = viewport.height - anchor.bottom - GAP - MARGIN;
  const spaceAbove = anchor.top - GAP - MARGIN;
  const fitsBelow = panel.height <= spaceBelow;
  const fitsAbove = panel.height <= spaceAbove;
  const down = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove);
  const unclamped = align === 'end' ? anchor.right - panel.width : anchor.left;
  const left = Math.min(Math.max(unclamped, MARGIN), viewport.width - MARGIN - panel.width);
  const maxHeight = Math.max(0, down ? spaceBelow : spaceAbove);
  return down
    ? { left, top: anchor.bottom + GAP, maxHeight }
    : { left, bottom: viewport.height - anchor.top + GAP, maxHeight };
}

/** Height the panel content needs, even while the panel is clipped by its max height. */
function naturalHeight(element: HTMLElement): number {
  return element.scrollHeight + element.offsetHeight - element.clientHeight;
}

const samePlacement = (a: Placement | null, b: Placement) =>
  a !== null && a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.maxHeight === b.maxHeight;

/** A trigger with a floating panel. Closes on outside click, Escape and close actions. The panel stays inside the viewport. */
export function Popover({ trigger, children, align = 'start', panelClassName, label }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const panelElement = panel.current;
    const anchorElement = anchor.current;
    if (!panelElement || !anchorElement) return;
    const next = placeFloating(
      anchorElement.getBoundingClientRect(),
      { width: panelElement.offsetWidth, height: naturalHeight(panelElement) },
      align,
      { width: window.innerWidth, height: window.innerHeight }
    );
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [align]);

  useLayoutEffect(() => {
    if (open) reposition();
    else setPlacement(null);
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const panelElement = panel.current;
    const resizeObserver = panelElement ? new ResizeObserver(reposition) : null;
    if (panelElement) resizeObserver?.observe(panelElement);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    const first = panel.current?.querySelector<HTMLElement>('button:not(:disabled), input, select, textarea');
    first?.focus({ preventScroll: true });
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = () => setOpen(false);
  const style: CSSProperties = placement
    ? { left: placement.left, top: placement.top, bottom: placement.bottom, maxHeight: placement.maxHeight }
    : { left: 0, top: 0, visibility: 'hidden' };
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
          style={style}
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
