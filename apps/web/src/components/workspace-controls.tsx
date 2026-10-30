import { type ComponentProps, type ReactNode, useId } from 'react';
import { Tooltip } from './tooltip.js';
import './workspace-controls.css';

export function IconAction({
  label,
  tooltip,
  children,
  destructive = false,
  className = '',
  ...props
}: Omit<ComponentProps<'button'>, 'aria-label'> & {
  label: string;
  tooltip?: string;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={tooltip ?? label}>
      <button
        {...props}
        type="button"
        aria-label={label}
        className={`workspace-icon-action${destructive ? ' destructive' : ''} ${className}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}
export function SearchField({
  label,
  className = '',
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'aria-label'> & { label: string }) {
  return (
    <label className={`workspace-search ${className}`}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
      <input
        {...props}
        type="search"
        aria-label={label}
        placeholder={props.placeholder ?? label}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
      />
    </label>
  );
}
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  help,
  stateLabel,
  className = '',
  hideLabel = false,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  help?: string;
  stateLabel?: string;
  className?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className={`workspace-switch-field ${className}`}>
      {!hideLabel && <span id={id}>{label}</span>}
      <button
        type="button"
        role="switch"
        aria-label={hideLabel ? label : undefined}
        aria-labelledby={hideLabel ? undefined : id}
        aria-describedby={help ? `${id}-help` : undefined}
        aria-checked={checked}
        disabled={disabled}
        className="workspace-switch"
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
      {stateLabel && (
        <span className="workspace-switch-state" aria-hidden="true">
          {stateLabel}
        </span>
      )}
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  );
}
export function Pagination({
  label,
  previousLabel,
  nextLabel,
  summary,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  disabled = false,
}: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  summary: ReactNode;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious(): void;
  onNext(): void;
  disabled?: boolean;
}) {
  return (
    <nav className="workspace-pagination" aria-label={label}>
      <button
        type="button"
        className="secondary"
        aria-label={previousLabel}
        disabled={disabled || !canPrevious}
        onClick={onPrevious}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path d="m14 5-7 7 7 7" />
        </svg>
      </button>
      <span aria-live="polite">{summary}</span>
      <button
        type="button"
        className="secondary"
        aria-label={nextLabel}
        disabled={disabled || !canNext}
        onClick={onNext}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path d="m10 5 7 7-7 7" />
        </svg>
      </button>
    </nav>
  );
}
