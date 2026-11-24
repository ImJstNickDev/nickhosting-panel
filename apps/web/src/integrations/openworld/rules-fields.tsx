import type { CSSProperties, ReactNode } from 'react';
import type { OpenworldRulesSnapshot } from '../../../../../games/openworld/src/rules.js';
import { useT } from '../../app/i18n.js';

export type RuleSnapshot = OpenworldRulesSnapshot & { processRef: string };
export type Zone = NonNullable<RuleSnapshot['zones']>[number];
export type Group = NonNullable<RuleSnapshot['roles']>['entries'][number];
export type RuleText = ReturnType<typeof useRuleText>;
export function useRuleText() {
  const t = useT();
  return (key: string, vars?: Record<string, string | number>) =>
    t(`games.openworld.rules.${key}`, vars);
}
const paths = {
  world:
    'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3.5 9h17m-17 6h17M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z',
  groups: 'M3.5 7.5 12 3l8.5 4.5L12 12 3.5 7.5Zm0 4.5L12 16.5l8.5-4.5m-17 4.5L12 21l8.5-4.5',
  refresh: 'M20 8a8.5 8.5 0 1 0 .4 7M20 3v5.5h-5.5',
  arrow: 'm9 6 6 6-6 6',
  back: 'm15 6-6 6 6 6',
  external: 'M8 6h10v10M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'm4.5 12 5 5L20 6.5',
  inherit: 'M5 5v5a4 4 0 0 0 4 4h9m-4-4 4 4-4 4',
  edit: 'm15.5 4.5 4 4M4 20l4.5-.9L20 7.6 16.4 4 4.9 15.5 4 20Z',
  zone: 'm12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4L12 2.8Z',
  travel: 'M19.5 4.5 14 20l-3.2-6.8L4 10l15.5-5.5Z',
  settings: 'M3 6h10m4 0h4M3 12h3m4 0h11M3 18h10m4 0h4M13 4v4M7 10v4m7 2v4',
  close: 'm6 6 12 12M18 6 6 18',
  difficulty: 'M3 19v-4m5 4v-8m5 8V7m5 12V3',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 14h10l1-14M10 10v6m4-6v6',
};
export function RuleIcon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function tintStyle(value?: string): CSSProperties {
  return {
    '--rule-tint': value && /^#[0-9a-f]{6}$/i.test(value) ? value : 'var(--ow-primary)',
  } as CSSProperties;
}
export function SettingRow({
  label,
  value,
  hint,
  edit,
  actionLabel,
}: {
  label: string;
  value?: ReactNode;
  hint?: string;
  edit?: () => void;
  actionLabel?: string;
}) {
  const r = useRuleText();
  return (
    <div className="ow-setting-row">
      <div>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <span className="ow-setting-value">{value}</span>
      {edit && (
        <button
          type="button"
          className="ow-rule-icon"
          aria-label={actionLabel ?? r('editSetting', { name: label })}
          onClick={edit}
        >
          <RuleIcon name="edit" />
        </button>
      )}
    </div>
  );
}
