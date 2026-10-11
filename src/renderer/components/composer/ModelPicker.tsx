import { Check, ChevronDown, RotateCw } from 'lucide-react';
import type { ReasoningEffort } from '@shared/config';
import { REASONING_EFFORTS } from '@shared/config';
import type { ModelCatalog } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { cx } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { Popover } from '../common/Popover';

export interface ModelValue {
  model: string | null;
  reasoning: ReasoningEffort | null;
}

interface ModelPickerProps {
  value: ModelValue;
  catalog: ModelCatalog;
  onChange(value: ModelValue): void;
  disabled?: boolean;
  className?: string;
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  pro: 'Pro'
};

export function modelLabel(catalog: ModelCatalog, model: string | null): string {
  const labelOf = (id: string) => catalog.models.find((option) => option.id === id)?.label ?? id;
  if (model) return labelOf(model);
  return catalog.defaultModel ? `Default (${labelOf(catalog.defaultModel)})` : 'Default';
}

/** Model and reasoning effort. `model: null` means the account default. */
export function ModelPicker({ value, catalog, onChange, disabled, className }: ModelPickerProps) {
  const effective = value.model ?? catalog.defaultModel;
  const efforts = catalog.models.find((option) => option.id === effective)?.efforts ?? [];
  const label = modelLabel(catalog, value.model);
  const effortLabel = value.reasoning ? ` · ${EFFORT_LABEL[value.reasoning]}` : '';

  return (
    <Popover
      label="Model"
      panelClassName="is-picker"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={cx('chip chip-button', className)}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          title="Model and reasoning"
          onClick={toggle}
        >
          <span className="chip-text">{label}{effortLabel}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      )}
    >
      {() => (
        <div className="picker">
          <div className="picker-label">Model</div>
          <button type="button" className="menu-item" onClick={() => onChange({ model: null, reasoning: null })}>
            <span className="menu-text">{modelLabel(catalog, null)}</span>
            {value.model === null && <Check size={14} className="menu-check" aria-hidden="true" />}
          </button>
          {catalog.models.map((option) => (
            <button
              key={option.id}
              type="button"
              className="menu-item"
              onClick={() => onChange({ model: option.id, reasoning: value.reasoning && option.efforts.includes(value.reasoning) ? value.reasoning : null })}
            >
              <span className="menu-text">{option.label}</span>
              {value.model === option.id && <Check size={14} className="menu-check" aria-hidden="true" />}
            </button>
          ))}
          {catalog.state === 'loading' && <p className="picker-note">Loading models…</p>}
          {catalog.state === 'error' && (
            <p className="picker-note is-error">
              {catalog.error ?? 'Models unavailable.'}
              <button
                type="button"
                className="link-btn"
                onClick={() => invoke('browser:refreshModels').catch(reportError)}
              >
                <RotateCw size={11} aria-hidden="true" /> Retry
              </button>
            </p>
          )}
          {efforts.length > 0 && (
            <>
              <div className="picker-label">Reasoning</div>
              <button type="button" className="menu-item" onClick={() => onChange({ ...value, reasoning: null })}>
                <span className="menu-text">Default</span>
                {value.reasoning === null && <Check size={14} className="menu-check" aria-hidden="true" />}
              </button>
              {REASONING_EFFORTS.filter((effort) => efforts.includes(effort)).map((effort) => (
                <button key={effort} type="button" className="menu-item" onClick={() => onChange({ ...value, reasoning: effort })}>
                  <span className="menu-text">{EFFORT_LABEL[effort]}</span>
                  {value.reasoning === effort && <Check size={14} className="menu-check" aria-hidden="true" />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </Popover>
  );
}
