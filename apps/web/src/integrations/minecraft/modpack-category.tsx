/** Provider category names remain provider content; only normalize their casing. */
export function formatModpackCategoryName(name: string): string {
  return name
    .replaceAll('-', ' ')
    .replace(
      /(^|[\s/])(\p{Ll})/gu,
      (_, gap: string, letter: string) => `${gap}${letter.toUpperCase()}`,
    );
}

const categoryIcons: readonly [RegExp, string][] = [
  [/^all$/, 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  [/adventure|exploration/, 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4 5-2 6-6 2 2-6Z'],
  [
    /tech|automation/,
    'M6 6h12v12H6zM9 9h6v6H9zM9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3',
  ],
  [/magic/, 'm4 18 12-12 4 4L8 22ZM13 9l4 4M5 3v6M2 6h6m10-4v4m-2-2h4'],
  [/quest|rpg/, 'M6 3h12v18H6zM9 7h6M9 11h6m-6 5 2 2 4-4'],
  [/optimization|performance/, 'M4 18a9 9 0 1 1 16 0M12 13l5-5M7 18h10'],
  [/light|small/, 'M5 19C3 8 10 3 20 4c0 9-5 16-15 15Zm0 0L16 8M4 21l1-2'],
  [/combat|pvp/, 'm4 20 3-3m-3-3 6 6M7 17 20 4h-6L7 11m7 6 3 3m-3 0 6-6M4 4l6 6'],
  [
    /multiplayer|social/,
    'M9 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-6 15v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5v1',
  ],
  [/kitchen sink/, 'M3 11h18v5a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Zm9 0V5a2 2 0 0 1 4 0v1M6 20v2m12-2v2'],
  [/skyblock/, 'm4 10 8-4 8 4-8 4Zm0 0v6l8 4 8-4v-6m-8 4v6M5 3H3m18 0h-2'],
  [/hardcore|horror/, 'M6 16a8 8 0 1 1 12 0v5H6Zm3 1v4m6-4v4M8 10h2v2H8zm6 0h2v2h-2z'],
  [/large/, 'm12 3 9 5-9 5-9-5Zm-9 5v10l9 5 9-5V8m-9 5v10'],
  [
    /sci[ -]?fi/,
    'M8 15C9 8 14 4 21 3c-1 7-5 12-12 13Zm0 0-4 1 1-5 5-2m-1 7-1 4 5-1 2-5M4 20l2-2M15 7h2v2h-2z',
  ],
  [/vanilla/, 'm12 3 8 4-8 4-8-4Zm-8 4v10l8 4 8-4V7m-8 4v10'],
];
const tagIcon = 'M3 3h8l10 10-8 8L3 11Zm4 4h.01';

export function ModpackCategoryIcon({ name }: { name: string }) {
  const normalized = name.toLowerCase().replaceAll('-', ' ');
  const path = categoryIcons.find(([pattern]) => pattern.test(normalized))?.[1] ?? tagIcon;
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}
