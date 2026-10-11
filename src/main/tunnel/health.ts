/**
 * Health signals from tunnel-client, and the rules that turn them into a connection state.
 *
 * /readyz is a local check and stays green through an internet outage, so the only proof that
 * ChatGPT can reach this PC is the client's poll metric: the unix time of its last successful
 * poll of OpenAI's control plane. Everything here is loopback-only and never throws.
 */

/** Polls are at most 30 s apart; allow three of them before calling the link lost. */
export const POLL_FRESH_MS = 95_000;
/**
 * How long a run of "cannot reach OpenAI" complaints must go unanswered by a completed poll before
 * it is an outage. The client retries on its own, so a single dropped read is not news.
 */
export const OUTAGE_CONFIRM_MS = 35_000;

/** Sums every sample of a Prometheus metric, ignoring labels. */
export function readMetric(text: string, name: string): number | null {
  let total: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith(name)) continue;
    const rest = trimmed.slice(name.length);
    // Must be the whole name: `..._poll_cycles` must not match `..._poll_cycles_total`.
    if (rest !== '' && rest[0] !== ' ' && rest[0] !== '{') continue;
    const sample = rest.replace(/^\{[^}]*\}/, '').trim().split(/\s+/)[0];
    const value = Number(sample);
    if (!sample || !Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

export interface PollHealth {
  /** Epoch ms of the last successful control-plane poll; null before the first one. */
  lastSuccessMs: number | null;
  /** Poll errors since the client started. */
  errors: number | null;
}

async function fetchText(url: string, timeoutMs: number): Promise<{ ok: boolean; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, body: (await res.text()).trim() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Null when the metrics endpoint is unreachable or lacks the poll timestamp (unknown, not zero). */
export async function readPollHealth(base: string): Promise<PollHealth | null> {
  const result = await fetchText(`${base}/metrics`, 3000);
  if (!result?.ok) return null;
  const seconds = readMetric(result.body, 'commands_poll_last_successful_timestamp_seconds');
  if (seconds === null) return null;
  return {
    lastSuccessMs: seconds > 0 ? Math.round(seconds * 1000) : null,
    errors: readMetric(result.body, 'commands_poll_errors_total')
  };
}

/** The client's own readiness gate; the body names why it is not ready. */
export async function probeReady(base: string): Promise<{ ok: boolean; detail: string }> {
  const result = await fetchText(`${base}/readyz`, 3000);
  return result ? { ok: result.ok, detail: result.ok ? '' : result.body.slice(0, 200) } : { ok: false, detail: '' };
}

/**
 * Whether a tunnel-client log record says OpenAI refused the credentials. Only the control-plane
 * poll and metadata paths count; a 401 from anywhere else is not about the tunnel key.
 */
export function isAuthRejection(message: string, error: string, statusCode?: unknown): boolean {
  const controlPlane =
    /^(?:poll failed(?:;\s*backing off)?|tunnel metadata fetch failed)$/i.test(message) ||
    /\bcontrolplane (?:client|responder):/i.test(error);
  if (!controlPlane) return false;
  if (typeof statusCode === 'number') return statusCode === 401 || statusCode === 403;
  return /\b(?:(?:unexpected status(?: code)?|HTTP)\s*:?\s*(?:401|403)|401\s+Unauthorized|403\s+Forbidden|unauthorized|forbidden|invalid[_ ]api[_ ]key|tunnel_use_forbidden)\b/i.test(
    error
  );
}

const CONTROL_PLANE_POLL = /\bpoll (?:failed|timed out(?:;\s*backing off)?)\b/i;
const UNREACHABLE_NETWORK =
  /no such host|dial tcp|i\/o timeout|timed out|context deadline exceeded|connection (was )?(aborted|refused|reset)|network is (unreachable|down)|no route to host|tls handshake timeout|temporary failure in name resolution|forcibly closed/i;

/** A control-plane poll that failed for lack of network, as opposed to a broken tunnel. */
export function isUnreachable(text: string): boolean {
  return CONTROL_PLANE_POLL.test(text) && UNREACHABLE_NETWORK.test(text);
}

/** A run of unreachable complaints not yet contradicted by a completed poll. */
export interface OutageRun {
  since: number;
  /** The last completed poll when the run began; null if there had never been one. */
  handshakeBefore: number | null;
}

export function outageConfirmed(run: OutageRun | null, now: number): boolean {
  return run !== null && now - run.since >= OUTAGE_CONFIRM_MS;
}

/** A poll completing after the run began ends it. */
export function outageRecovered(run: OutageRun | null, lastHandshake: number | null): boolean {
  if (run === null || lastHandshake === null) return false;
  return run.handshakeBefore === null || lastHandshake > run.handshakeBefore;
}

export function describeNetworkError(raw: string): string {
  if (/no such host|name resolution/i.test(raw)) return 'no internet connection';
  if (/connection (was )?(aborted|reset)|forcibly closed/i.test(raw)) return 'the connection dropped';
  if (/refused/i.test(raw)) return 'the connection was refused';
  if (/timeout|timed out|context deadline exceeded/i.test(raw)) return 'the connection timed out';
  if (/network is (unreachable|down)|no route to host/i.test(raw)) return 'the network is unreachable';
  return 'a network error';
}
