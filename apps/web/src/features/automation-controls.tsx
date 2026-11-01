import { useRef, useState } from 'react';
import { ErrorNotice } from '../components/ui.js';
import { Switch } from '../components/workspace-controls.js';
export function AutomationSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (value: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const pending = useRef(false);
  return (
    <div className="automation-switch-wrap">
      <Switch
        label={label}
        hideLabel
        checked={checked}
        disabled={disabled || busy}
        onChange={async (value) => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError(undefined);
          try {
            await onChange(value);
          } catch (error) {
            setError(error);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      />
      {!!error && <ErrorNotice error={error} />}
    </div>
  );
}
