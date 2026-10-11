import { useEffect, useRef, type KeyboardEvent } from 'react';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** Modal confirmation. Cancel has initial focus so Enter never destroys by accident. */
export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id="confirm-title" className="modal-title">{title}</h2>
        <p id="confirm-message" className="modal-text">{message}</p>
        <div className="modal-actions">
          <button ref={cancel} type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
