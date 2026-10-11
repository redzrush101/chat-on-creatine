import { Check, ChevronDown, RotateCw } from 'lucide-react';
import type { ReasoningEffort } from '@shared/config';
import { REASONING_EFFORTS } from '@shared/config';
import type { ModelCatalog } from '@shared/types';
import { findModel, modelSelection } from '@shared/model-selection';
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

function labelOf(catalog: ModelCatalog, id: string): string {
  return findModel(catalog.models, id)?.label ?? id;
}

/**
 * Model and reasoning effort as two quiet triggers, "GPT-5 Thinking · Medium", like the Claude
 * app's model and effort controls. `model: null` means the account default.
 */
export function ModelPicker({ value, catalog, onChange, disabled }: ModelPickerProps) {
  const effective = value.model ?? catalog.defaultModel;
  const option = findModel(catalog.models, effective);
  const efforts = option?.efforts ?? [];
  const reasoning = value.reasoning ?? option?.presets?.find((preset) => preset.model === effective)?.reasoning ?? null;
  const effortLabel = (effort: ReasoningEffort) => option?.presets?.find((preset) => preset.reasoning === effort)?.label ?? EFFORT_LABEL[effort];
  const modelText = value.model ? labelOf(catalog, value.model) : catalog.defaultModel ? labelOf(catalog, catalog.defaultModel) : 'Default model';

  return (
    <>
      <Popover
        label="Model"
        align="end"
        panelClassName="is-picker"
        trigger={({ open, toggle }) => (
          <button type="button" className="quiet-trigger" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title={value.model ? 'Model' : 'Model (account default)'} onClick={toggle}>
            <span className="chip-text">{modelText}</span>
          </button>
        )}
      >
        {(close) => (
          <div className="picker">
            <div className="picker-label">Model</div>
            <button type="button" className="menu-item" onClick={() => {
                  onChange({ model: null, reasoning: null });
                  close();
                }}>
              <span className="menu-text">{catalog.defaultModel ? `Default (${labelOf(catalog, catalog.defaultModel)})` : 'Default'}</span>
              {value.model === null && <Check size={14} className="menu-check" aria-hidden="true" />}
            </button>
            {catalog.models.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="menu-item"
                onClick={() => {
                  onChange(modelSelection(entry, reasoning));
                  close();
                }}
              >
                <span className="menu-text">{entry.label}</span>
                {value.model !== null && option === entry && <Check size={14} className="menu-check" aria-hidden="true" />}
              </button>
            ))}
            {catalog.state === 'loading' && <p className="picker-note">Loading models…</p>}
            {catalog.state === 'error' && (
              <p className="picker-note is-error">
                {catalog.error ?? 'Models unavailable.'}
                <button type="button" className="link-btn" onClick={() => invoke('browser:refreshModels').catch(reportError)}>
                  <RotateCw size={11} aria-hidden="true" /> Retry
                </button>
              </p>
            )}
          </div>
        )}
      </Popover>
      {efforts.length > 0 && (
        <Popover
          label="Reasoning effort"
          align="end"
          panelClassName="is-picker"
          trigger={({ open, toggle }) => (
            <button type="button" className="quiet-trigger" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} title="Reasoning effort" onClick={toggle}>
              <span className="chip-text">{reasoning ? effortLabel(reasoning) : 'Default'}</span>
            </button>
          )}
        >
          {(close) => (
            <div className="picker">
              <div className="picker-label">Reasoning</div>
              <button type="button" className="menu-item" onClick={() => {
                  onChange({ ...value, reasoning: null });
                  close();
                }}>
                <span className="menu-text">Default</span>
                {reasoning === null && <Check size={14} className="menu-check" aria-hidden="true" />}
              </button>
              {REASONING_EFFORTS.filter((effort) => efforts.includes(effort)).map((effort) => (
                <button key={effort} type="button" className="menu-item" onClick={() => {
                  if (option) onChange(modelSelection(option, effort));
                  close();
                }}>
                  <span className="menu-text">{effortLabel(effort)}</span>
                  {reasoning === effort && <Check size={14} className="menu-check" aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </>
  );
}

/** A labelled dropdown trigger with a leading chevron, like the Claude app's "⌄ Auto". */
export function DropdownLabel({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cx('dropdown-label', className)}>
      <ChevronDown size={13} aria-hidden="true" />
      <span className="chip-text">{text}</span>
    </span>
  );
}
