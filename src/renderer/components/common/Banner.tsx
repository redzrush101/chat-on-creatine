import type { ReactNode } from 'react';
import { cx } from '../../lib/format';

interface BannerProps {
  tone: 'warning' | 'danger' | 'info';
  icon: ReactNode;
  children: ReactNode;
  action?: { label: string; onClick(): void };
}

export function Banner({ tone, icon, children, action }: BannerProps) {
  return (
    <div className={cx('banner', `banner-${tone}`)} role="status">
      <span className="banner-icon" aria-hidden="true">{icon}</span>
      <span className="banner-text">{children}</span>
      {action && (
        <button type="button" className="btn btn-small" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
