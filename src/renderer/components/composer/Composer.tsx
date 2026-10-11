import { Check, CircleAlert, CornerDownLeft, LoaderCircle, Paperclip, Plug, Plus, Square, WifiOff, X } from 'lucide-react';
import { invoke } from '../../lib/bridge';
import { basename, cx } from '../../lib/format';
import { reportError } from '../common/Toasts';
import { Banner } from '../common/Banner';
import { Menu } from '../common/Popover';
import { ContextMeter } from './ContextMeter';
import { DropdownLabel, ModelPicker } from './ModelPicker';
import { PendingInputs } from './PendingInputs';
import { RepoBar } from './RepoBar';
import { MODES, useComposer } from './useComposer';
import type { ComposerProps } from './types';

export function Composer(props: ComposerProps) {
  const { app, session, activity, hero, onOpenSettings, rootDir, onReviewChanges } = props;
  const {
    sessionId, text, setText, field, attachments, setAttachments, busy, canStop, mode, browserBlocked,
    toolsOffline, inputs, canSend, attach, setMode, submit, stop, onKeyDown, modelValue, modelChange, placeholder
  } = useComposer(props);
  const modeLabel = MODES.find((item) => item.value === mode)?.label ?? 'Normal';

  return (
    <div className={cx('composer-wrap', hero && 'is-hero')}>
      {activity && (
        <div className={cx('turn-activity', activity.failed && 'is-failed', activity.active && 'is-active')} role="status" aria-live="polite" aria-atomic="true">
          {activity.active ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : activity.failed ? <CircleAlert size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          <span>{activity.label}</span>
        </div>
      )}
      <ComposerStatus app={app} hero={hero} onOpenSettings={onOpenSettings} sessionId={sessionId} browserBlocked={browserBlocked} toolsOffline={toolsOffline} inputs={inputs} />
      {session && onReviewChanges && <RepoBar rootDir={rootDir ?? null} refreshKey={app.live[session.id]?.turn ?? 'idle'} onReview={onReviewChanges} />}

      <div className="composer">
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((path) => (
              <span key={path} className="file-chip" title={path}>
                <Paperclip size={12} aria-hidden="true" />
                <span className="file-chip-name">{basename(path)}</span>
                <button
                  type="button"
                  className="icon-btn file-chip-remove"
                  aria-label={`Remove ${basename(path)}`}
                  onClick={() => {
                    setAttachments((current) => current.filter((item) => item !== path));
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            ref={field}
            className="composer-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label="Message"
            spellCheck
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <ComposerActions busy={busy} canStop={canStop} canSend={canSend} browserBlocked={browserBlocked} submit={submit} stop={stop} />
        </div>
      </div>

      <div className="composer-foot">
        <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files" onClick={attach}>
          <Plus size={16} />
        </button>
        <Menu
          label="Mode"
          entries={MODES.map((item) => ({ label: `${item.label} — ${item.hint}`, checked: item.value === mode, onSelect: () => setMode(item.value) }))}
          trigger={({ open, toggle }) => (
            <button type="button" className="quiet-trigger" aria-haspopup="menu" aria-expanded={open} title={MODES.find((item) => item.value === mode)?.hint} onClick={toggle}>
              <DropdownLabel text={modeLabel} />
            </button>
          )}
        />
        {hero && toolsOffline && (
          <button type="button" className="link-btn composer-offline" onClick={() => onOpenSettings('connection')}>
            <Plug size={11} aria-hidden="true" /> Local tools offline
          </button>
        )}
        <span className="composer-spacer" />
        <ModelPicker value={modelValue} catalog={app.models} onChange={modelChange} />
        {session && <ContextMeter sessionId={session.id} tokens={session.contextTokens} advisory={app.config.context.advisoryTokens} />}
      </div>
    </div>
  );
}

function ComposerActions({ busy, canStop, canSend, browserBlocked, submit, stop }: Pick<ReturnType<typeof useComposer>, 'busy' | 'canStop' | 'canSend' | 'browserBlocked' | 'submit' | 'stop'>) {
  return (
    <div className="composer-actions">
      {busy && canSend && (
        <>
          <button type="button" className="btn btn-small" title="Queue: sent after this turn (Enter)" onClick={() => void submit('after-turn')}>
            Queue
          </button>
          <button type="button" className="btn btn-small btn-primary" title="Steer: reaches the model with its next tool result (Ctrl/Cmd+Enter)" onClick={() => void submit('now')}>
            Steer
          </button>
        </>
      )}
      {!busy && (
        <button
          type="button"
          className="icon-btn btn-send"
          aria-label="Send"
          title={browserBlocked ? 'Sign in to ChatGPT to send' : 'Send (Enter)'}
          disabled={!canSend || browserBlocked}
          onClick={() => void submit('now')}
        >
          <CornerDownLeft size={15} />
        </button>
      )}
      {canStop && (
        <button type="button" className="icon-btn btn-stop" aria-label="Stop" title="Stop (Esc)" onClick={stop}>
          <Square size={10} fill="currentColor" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ComposerStatus({ app, hero, onOpenSettings, sessionId, browserBlocked, toolsOffline, inputs }: Pick<ComposerProps, 'app' | 'hero' | 'onOpenSettings'> & Pick<ReturnType<typeof useComposer>, 'sessionId' | 'browserBlocked' | 'toolsOffline' | 'inputs'>) {
  return (
    <>
      {browserBlocked && (
        <Banner
          tone="warning"
          icon={<CircleAlert size={14} />}
          action={
            app.browser.signedIn === false
              ? { label: 'Sign in to ChatGPT', onClick: () => invoke('browser:signIn').catch(reportError) }
              : { label: 'Show ChatGPT', onClick: () => invoke('browser:show', sessionId).catch(reportError) }
          }
        >
          {app.browser.signedIn === false
            ? 'Not signed in to ChatGPT. Sign in before sending.'
            : 'ChatGPT is not ready yet. Messages cannot be sent until it is.'}
        </Banner>
      )}
      {!browserBlocked && toolsOffline && !hero && (
        <Banner
          tone="info"
          icon={<WifiOff size={14} />}
          action={{ label: 'Open connection', onClick: () => onOpenSettings('connection') }}
        >
          Local tools are offline. Chats still run, but ChatGPT cannot reach this computer.
        </Banner>
      )}
      {inputs.length > 0 && <PendingInputs inputs={inputs} />}
    </>
  );
}
