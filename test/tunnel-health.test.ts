import { describe, expect, it } from 'vitest';
import {
  isAuthRejection,
  isUnreachable,
  outageConfirmed,
  outageRecovered,
  readMetric,
  OUTAGE_CONFIRM_MS
} from '../src/main/tunnel/health';

describe('tunnel auth classification', () => {
  it('treats a control-plane 401/403 as a rejected key', () => {
    expect(isAuthRejection('poll failed', 'controlplane client: unexpected status code 401', undefined)).toBe(true);
    expect(isAuthRejection('poll failed', '', 403)).toBe(true);
  });

  it('does not treat unrelated 401s or retry numbers as a rejected key', () => {
    expect(isAuthRejection('dispatcher error', 'upstream returned 401')).toBe(false);
    expect(isAuthRejection('poll failed', 'retrying in 401ms')).toBe(false);
  });
});

describe('outage confirmation', () => {
  it('reports unreachable only for control-plane poll failures on the network', () => {
    expect(isUnreachable('poll failed: dial tcp: i/o timeout')).toBe(true);
    expect(isUnreachable('startup probe: i/o timeout')).toBe(false);
  });

  it('confirms an outage only after a full poll cycle with no completed poll', () => {
    const run = { since: 1_000, handshakeBefore: 500 };
    expect(outageConfirmed(run, 1_000 + OUTAGE_CONFIRM_MS - 1)).toBe(false);
    expect(outageConfirmed(run, 1_000 + OUTAGE_CONFIRM_MS)).toBe(true);
    expect(outageRecovered(run, 500)).toBe(false);
    expect(outageRecovered(run, 900)).toBe(true);
  });

  it('reads a metric by its whole name, summing labelled samples', () => {
    const text = [
      '# TYPE commands_poll_errors_total counter',
      'commands_poll_errors_total{error_kind="a"} 2',
      'commands_poll_errors_total{error_kind="b"} 3',
      'commands_poll_errors_total_created 9'
    ].join('\n');
    expect(readMetric(text, 'commands_poll_errors_total')).toBe(5);
  });
});
