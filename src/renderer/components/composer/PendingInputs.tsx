import { useState } from 'react';
import { Pencil, Send, X } from 'lucide-react';
import type { InputItem } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { reportError } from '../common/Toasts';
import { InlineEdit } from '../common/InlineEdit';

/** Messages waiting for their turn to end, or steered in, shown above the composer. */
export function PendingInputs({ inputs }: { inputs: InputItem[] }) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <ul className="pending" aria-label="Queued messages">
      {inputs.map((item) => {
        const sending = item.state === 'sending';
        return (
          <li key={item.id} className={`pending-item is-${item.state}`}>
            <span className="pending-tag">{item.delivery === 'now' ? 'Steer' : 'Queued'}</span>
            {editing === item.id ? (
              <InlineEdit
                label="Queued message"
                value={item.text}
                className="inline-edit pending-edit"
                onCancel={() => setEditing(null)}
                onCommit={(text) => {
                  setEditing(null);
                  invoke('inputs:update', item.id, { text }).catch(reportError);
                }}
              />
            ) : (
              <span className="pending-text" title={item.text}>
                {item.text || `${item.attachments.length} attachment(s)`}
              </span>
            )}
            {item.error && <span className="pending-error" title={item.error}>failed</span>}
            {sending ? (
              <span className="pending-state">Sending…</span>
            ) : (
              <span className="pending-actions">
                <button type="button" className="icon-btn" aria-label="Edit queued message" title="Edit" onClick={() => setEditing(item.id)}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="icon-btn" aria-label="Send now" title="Send now" onClick={() => invoke('inputs:sendNow', item.id).catch(reportError)}>
                  <Send size={12} />
                </button>
                <button type="button" className="icon-btn" aria-label="Cancel queued message" title="Cancel" onClick={() => invoke('inputs:cancel', item.id).catch(reportError)}>
                  <X size={12} />
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
