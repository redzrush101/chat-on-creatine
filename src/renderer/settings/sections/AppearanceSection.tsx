import type { JSX } from 'react';
import type { AppState } from '@shared/types';
import { Group, Row, SelectField, Segmented, Slider, Toggle, useSave } from '../controls';

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
        <Row label="Language">
          <SelectField
            label="Language"
            value={config.ui.language}
            options={[
              { value: 'en', label: 'English' },
              { value: 'de', label: 'Deutsch' }
            ]}
            onChange={(language) => save({ ui: { language } })}
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
      <Group title="Window">
        <Row label="Keep running in the tray" hint="Closing the window leaves the app running so tools stay connected.">
          <Toggle label="Keep running in the tray" checked={config.ui.closeToTray} onChange={(closeToTray) => save({ ui: { closeToTray } })} />
        </Row>
      </Group>
    </div>
  );
}
