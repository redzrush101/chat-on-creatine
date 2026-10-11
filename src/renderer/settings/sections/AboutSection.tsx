import type { JSX } from 'react';
import type { AppState } from '@shared/types';
import { Group, Row } from '../controls';

export function AboutSection({ state }: { state: AppState }): JSX.Element {
  return (
    <div className="st-stack">
      <Group title="Chat on Creatine">
        <Row label="Version">
          <span className="st-mono">{state.version}</span>
        </Row>
        <Row label="Platform">
          <span className="st-mono">{state.platform}</span>
        </Row>
      </Group>
    </div>
  );
}
