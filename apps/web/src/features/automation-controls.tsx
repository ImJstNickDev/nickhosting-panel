import { useState } from 'react';
import { ErrorNotice } from '../components/ui.js';
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
  return (
    <span className="automation-switch-wrap">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="automation-switch"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await onChange(!checked);
          } catch (error) {
            setError(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span />
      </button>
      {!!error && <ErrorNotice error={error} />}
    </span>
  );
}
