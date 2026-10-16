import type { JSX } from 'react';
import type { AppState } from '@shared/types';
import { Group, Row, Segmented, Slider, Toggle, useSave } from '../controls';

export function AppearanceSection({ state }: { state: AppState }): JSX.Element {
  const { config } = state;
  const save = useSave();
  return (
    <div className="st-stack">
      <Group title="Look">
        <Row stacked label="Theme">
          <Segmented
            label="Theme"
            value={config.ui.theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' }
            ]}
            onChange={(theme) => save({ ui: { theme } })}
          />
        </Row>
        <Row stacked label="Text size" hint="Scales all text in the app.">
          <Slider
            label="Text size"
            min={0.8}
            max={1.4}
            step={0.05}
            value={config.ui.fontScale}
            format={(value) => `${Math.round(value * 100)}%`}
            onCommit={(fontScale) => save({ ui: { fontScale } })}
          />
        </Row>
      </Group>
      <Group title="Conversation">
        <Row label="Density" hint="Use a closer layout for long conversations.">
          <Segmented label="Density" value={config.ui.density} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} onChange={(density) => save({ ui: { density } })} />
        </Row>
        <Row stacked label="Conversation width">
          <Slider label="Conversation width" min={600} max={1200} step={24} value={config.ui.chatWidth} format={(value) => `${value} px`} onCommit={(chatWidth) => save({ ui: { chatWidth } })} />
        </Row>
        <Row label="Expand tool details" hint="Show finished tool steps in the desktop and full tool output in the CLI.">
          <Toggle label="Expand tool details" checked={config.ui.expandTools} onChange={(expandTools) => save({ ui: { expandTools } })} />
        </Row>
        <Row label="Reduce motion" hint="Keep transitions and the terminal activity indicator still.">
          <Toggle label="Reduce motion" checked={config.ui.reducedMotion} onChange={(reducedMotion) => save({ ui: { reducedMotion } })} />
        </Row>
      </Group>
      <Group title="Window">
        <Row label="Keep running in the tray" hint="Closing the window leaves the app running so tools stay connected.">
          <Toggle label="Keep running in the tray" checked={config.ui.closeToTray} onChange={(closeToTray) => save({ ui: { closeToTray } })} />
        </Row>
      </Group>
    </div>
  );
}
