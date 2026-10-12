import { ChevronDown, RotateCw } from 'lucide-react';
import { REASONING_EFFORTS } from '@shared/config';
import type { ModelCatalog, ModelSelection } from '@shared/types';
import { effortLabel, findModel, modelSelection } from '@shared/model-selection';
import { invoke } from '../../lib/bridge';
import { cx } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { MenuList, Popover } from '../common/Popover';

interface ModelPickerProps {
  value: ModelSelection;
  catalog: ModelCatalog;
  onChange(value: ModelSelection): void;
  disabled?: boolean;
}

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
            <MenuList onClose={close} entries={[
              { kind: 'label', label: 'Model' },
              { label: catalog.defaultModel ? `Default (${labelOf(catalog, catalog.defaultModel)})` : 'Default',
                checked: value.model === null, onSelect: () => onChange({ model: null, reasoning: null }) },
              ...catalog.models.map((entry) => ({ label: entry.label, checked: value.model !== null && option === entry,
                onSelect: () => onChange(modelSelection(entry, reasoning)) }))
            ]} />
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
              <span className="chip-text">{reasoning ? effortLabel(option, reasoning) : 'Default'}</span>
            </button>
          )}
        >
          {(close) => (
            <div className="picker">
              <MenuList onClose={close} entries={[
                { kind: 'label', label: 'Reasoning' },
                { label: 'Default', checked: reasoning === null, onSelect: () => onChange({ ...value, reasoning: null }) },
                ...REASONING_EFFORTS.filter((effort) => efforts.includes(effort)).map((effort) => ({
                  label: effortLabel(option, effort), checked: reasoning === effort,
                  onSelect: () => { if (option) onChange(modelSelection(option, effort)); }
                }))
              ]} />
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
