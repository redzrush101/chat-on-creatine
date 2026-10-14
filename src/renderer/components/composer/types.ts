import type { AppState, AutomationMode, SessionMeta } from '@shared/types';
import type { ModelSelection } from '@shared/types';
import type { TurnActivity } from '@shared/turn-activity';

/** Settings for the chat that does not exist yet; kept by the app while the empty state shows. */
export interface NewChatDraft {
  projectId: string | null;
  model: ModelSelection;
  mode: AutomationMode;
}

export interface ComposerProps {
  app: AppState;
  /** Null composes the first message of a new chat. */
  session: SessionMeta | null;
  activity?: TurnActivity | null;
  newChat: NewChatDraft;
  onNewChatChange(patch: Partial<NewChatDraft>): void;
  onCreated(sessionId: string): void;
  onSubmitted(): void;
  onOpenSettings(section?: string): void;
  focusNonce: number;
  /** Text placed into the field (starter suggestions); applied each time `id` changes. */
  prefill?: { id: number; text: string };
  hero?: boolean;
  /** The chat folder; its git changes show in a bar above the field. */
  rootDir?: string | null;
  onReviewChanges?(): void;
}

