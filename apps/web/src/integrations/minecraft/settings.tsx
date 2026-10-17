import type { UiField } from '@nickhosting/game-sdk/ui';
import { minecraftFormattingTokens, minecraftUiCatalogs } from '@nickhosting/minecraft/ui';
import { useId, useMemo } from 'react';
import { useLocale, useT } from '../../app/i18n.js';
import type { GameFormViewProps } from '../../features/game-form-view.js';
import { MinecraftMessageEditor } from './gateway-editor.js';
import './settings.css';

const key = (name: string) => `games.minecraft.settings.${name}`;
const groups = [
  { id: 'gameplay', fields: ['difficulty', 'gamemode', 'pvp', 'allow-flight', 'hardcore'] },
  {
    id: 'access',
    fields: ['max-players', 'white-list', 'enforce-whitelist', 'player-idle-timeout'],
  },
  {
    id: 'world',
    fields: [
      'spawn-monsters',
      'spawn-animals',
      'spawn-npcs',
      'generate-structures',
      'spawn-protection',
    ],
  },
  { id: 'performance', fields: ['view-distance', 'simulation-distance'] },
  { id: 'description', fields: ['motd'] },
] as const;

const help: Record<string, string> = {
  motd: 'motdHelp',
  'allow-flight': 'flightHelp',
  hardcore: 'hardcoreHelp',
  'generate-structures': 'structuresHelp',
  'player-idle-timeout': 'idleHelp',
};

/** The integration supplies layout; shared forms own validation, authorization and jobs. */
export function MinecraftSettingsForm(props: GameFormViewProps) {
  const t = useT();
  const id = useId();
  const known = new Set<string>(groups.flatMap((group) => [...group.fields]));
  const sections = [
    ...groups.map((group) => ({
      id: group.id,
      fields: group.fields.flatMap((name) => props.fields.filter((field) => field.id === name)),
    })),
    { id: 'other', fields: props.fields.filter((field) => !known.has(field.id)) },
  ].filter((group) => group.fields.length > 0);

  return (
    <div className="minecraft-settings">
      {props.feedback}
      <fieldset disabled={props.disabled} className="minecraft-settings-fields">
        {sections.map((group) => (
          <section
            className={`minecraft-settings-group minecraft-settings-group--${group.id}`}
            aria-labelledby={`${id}-${group.id}`}
            key={group.id}
          >
            <h2
              id={`${id}-${group.id}`}
              className={group.id === 'description' ? 'visually-hidden' : undefined}
            >
              {t(key(group.id))}
            </h2>
            <div
              className={
                group.id === 'description'
                  ? 'minecraft-settings-motd'
                  : 'minecraft-settings-surface'
              }
            >
              {group.fields.map((field) => (
                <Property key={field.id} field={field} {...props} />
              ))}
            </div>
          </section>
        ))}
      </fieldset>
      {props.actions && <div className="form-footer">{props.actions}</div>}
    </div>
  );
}

function Property({
  field,
  values,
  errors,
  onChange,
  disabled,
  serverName,
}: GameFormViewProps & { field: UiField }) {
  const t = useT();
  const id = useId();
  const value = values[field.id];
  const error = errors[field.id];
  const helpName = help[field.id];
  const hint = field.helpKey ?? (helpName ? key(helpName) : undefined);
  const describedBy =
    [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  const messages = (
    <>
      {hint && (
        <p className="minecraft-settings-hint" id={`${id}-hint`}>
          {t(hint)}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {t(`gameUi.${error}`)}
        </p>
      )}
    </>
  );

  if (field.id === 'motd' && field.type === 'text') {
    return (
      <>
        <ServerMotd
          value={typeof value === 'string' ? value : ''}
          maxLength={field.maxLength}
          readOnly={disabled}
          serverName={serverName}
          onChange={(next) => onChange(field.id, next)}
        />
        {messages}
      </>
    );
  }

  if (field.type === 'choice') {
    return (
      <fieldset className="minecraft-settings-choice" aria-describedby={describedBy}>
        <legend>{t(field.labelKey)}</legend>
        <div className="minecraft-settings-options">
          {field.options.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={id}
                value={option.value}
                checked={value === option.value}
                disabled={option.disabled}
                aria-invalid={Boolean(error)}
                onChange={() => onChange(field.id, option.value)}
              />
              <span>{option.labelKey ? t(option.labelKey) : option.label}</span>
            </label>
          ))}
        </div>
        {messages}
      </fieldset>
    );
  }
  if (field.type === 'boolean') {
    return (
      <div className="minecraft-settings-row">
        <div>
          <label htmlFor={id}>{t(field.labelKey)}</label>
          {messages}
        </div>
        <button
          id={id}
          type="button"
          role="switch"
          className="minecraft-settings-switch"
          aria-checked={value === true}
          aria-label={t(field.labelKey)}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          onClick={() => onChange(field.id, value !== true)}
        >
          <span className="minecraft-settings-switch-thumb" />
        </button>
      </div>
    );
  }
  if (field.type === 'number') {
    return (
      <div className="minecraft-settings-row">
        <div>
          <label htmlFor={id}>{t(field.labelKey)}</label>
          {messages}
        </div>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          className="minecraft-settings-number"
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          min={field.min}
          max={field.max}
          step={field.integer ? 1 : 'any'}
          required={field.required}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) =>
            onChange(field.id, event.target.value === '' ? '' : Number(event.target.value))
          }
        />
      </div>
    );
  }
  if (field.type === 'text' || field.type === 'textarea') {
    return (
      <div className="minecraft-settings-text">
        <label className={field.id === 'motd' ? 'visually-hidden' : undefined} htmlFor={id}>
          {t(field.labelKey)}
        </label>
        <input
          id={id}
          type="text"
          value={typeof value === 'string' ? value : ''}
          minLength={field.minLength}
          maxLength={field.maxLength}
          required={field.required}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.id, event.target.value)}
        />
        {messages}
      </div>
    );
  }
  return null;
}

function ServerMotd({
  value,
  maxLength,
  readOnly,
  serverName,
  onChange,
}: {
  value: string;
  maxLength: number;
  readOnly: boolean;
  serverName: string;
  onChange(value: string): void;
}) {
  const { locale } = useLocale();
  const channel = useMemo(
    () => ({
      id: 'motd',
      label: {
        en: minecraftUiCatalogs.en['games.minecraft.properties.motd'] ?? '',
        it: minecraftUiCatalogs.it['games.minecraft.properties.motd'] ?? '',
      },
      maxLength,
      multiline: true,
      formatting: { tokens: minecraftFormattingTokens, caseInsensitive: true },
    }),
    [maxLength],
  );
  return (
    <MinecraftMessageEditor
      channel={channel}
      locale={locale === 'it' ? 'it' : 'en'}
      value={value}
      readOnly={readOnly}
      serverName={serverName}
      onChange={onChange}
      allowAlignment={false}
    />
  );
}
