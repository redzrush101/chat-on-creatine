import type { JSX } from 'react';
import type { ReasoningEffort } from '@shared/config';
import { effortLabel, findModel, modelSelection } from '@shared/model-selection';
import type { ModelCatalog } from '@shared/types';
import { Row, SelectField } from './controls';

interface ModelDefault {
  model: string | null;
  reasoning: ReasoningEffort | null;
}

/**
 * A default model and reasoning effort as two settings rows. Unset means "inherit", and then
 * the efforts offered are those of `inherited`, the model that applies instead.
 */
export function ModelDefaults({
  catalog,
  value,
  inherited,
  labels,
  onChange
}: {
  catalog: ModelCatalog;
  value: ModelDefault;
  inherited: string | null;
  labels: { model: string; modelHint: string; reasoning: string; reasoningHint?: string; unset: string };
  onChange(value: ModelDefault): void;
}): JSX.Element {
  const selected = findModel(catalog.models, value.model ?? inherited);
  return (
    <>
      <Row label={labels.model} hint={labels.modelHint}>
        <SelectField
          label={labels.model}
          value={value.model ? selected?.id ?? value.model : ''}
          options={[
            { value: '', label: labels.unset },
            ...catalog.models.map((model) => ({ value: model.id, label: model.label })),
            ...(value.model !== null && !selected ? [{ value: value.model, label: value.model }] : [])
          ]}
          onChange={(id) => {
            const option = findModel(catalog.models, id);
            onChange(option ? modelSelection(option, value.reasoning) : { model: null, reasoning: null });
          }}
        />
      </Row>
      <Row label={labels.reasoning} hint={labels.reasoningHint}>
        <SelectField<ReasoningEffort | ''>
          label={labels.reasoning}
          value={value.reasoning ?? ''}
          options={[
            { value: '', label: labels.unset },
            ...(selected?.efforts ?? []).map((effort) => ({ value: effort, label: effortLabel(selected, effort) }))
          ]}
          onChange={(effort) => {
            const selection = effort && selected ? modelSelection(selected, effort) : null;
            onChange({ model: selection?.model ?? value.model, reasoning: selection?.reasoning ?? null });
          }}
        />
      </Row>
    </>
  );
}
