import type { WebContents } from 'electron';

/** Only http(s) pages can be opened; everything else is refused before reaching the browser. */
export function parseWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be opened.');
  return url;
}

/** Resolves when the page stops loading or after `ms`, whichever comes first. */
export function loadSettled(wc: WebContents, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wc.on('did-stop-loading', done);
  });
}

