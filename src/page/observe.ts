import { conversationIdFromUrl, type PageEvent } from '@shared/page-protocol';
import * as dom from './dom';

const NOTICE_DEBOUNCE_MS = 200;
const LOCATION_POLL_MS = 500;

export function observePage(emit: (event: PageEvent) => void): () => void {
  let lastGenerating: boolean | null = null;
  let lastNotice: string | null = null;
  let lastUrl = location.href;

  function checkPage(): void {
    const generating = dom.isGenerating();
    if (generating !== lastGenerating) {
      lastGenerating = generating;
      emit({ type: 'generating', value: generating });
    }
    const notice = dom.readErrorNotice();
    const key = notice ? `${notice.level}:${notice.text}` : null;
    if (notice && key !== lastNotice) emit({ type: 'notice', level: notice.level, text: notice.text });
    lastNotice = key;
  }

  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleCheck = (): void => {
    if (checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      checkPage();
    }, NOTICE_DEBOUNCE_MS);
  };
  new MutationObserver(scheduleCheck).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-testid', 'data-state', 'class', 'hidden', 'aria-hidden']
  });

  const checkLocation = (): void => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    emit({ type: 'location', url: lastUrl, conversationId: conversationIdFromUrl(lastUrl) });
  };
  setInterval(checkLocation, LOCATION_POLL_MS);
  window.addEventListener('popstate', checkLocation);

  return checkPage;
}
