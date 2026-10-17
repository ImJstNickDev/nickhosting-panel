import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import type { GatewayMessageExtensionProps } from '../../features/gateway-message-extension.js';
import { messageChannels } from '../../features/gateway-message-preview.js';
import { GatewayRichText, type GatewayRichTextHandle } from '../../features/gateway-rich-text.js';
import './gateway-editor.css';

// All URLs are bundled first-party module resources, never API-supplied CSS or executable code.
const assets = minecraftUiModule.assets ?? {};
let fontRequest: Promise<unknown> | undefined;
function prepareFont() {
  if (fontRequest || !assets.gatewayFont || typeof FontFace === 'undefined') return;
  fontRequest ??= new FontFace('MinecraftPreview', `url(${JSON.stringify(assets.gatewayFont)})`)
    .load()
    .then((font) => document.fonts.add(font))
    // A source checkout without locally supplied Mojang resources remains editable.
    .catch(() => undefined);
}
const assetStyle = (name: string): CSSProperties =>
  assets[name] ? { backgroundImage: `url(${JSON.stringify(assets[name])})` } : {};

/** Static client chrome, outside the editable message and keyboard order. */
function ClientButton({ children }: { children: ReactNode }) {
  return (
    <span className="mc-game-button" style={assetStyle('gatewayButton')}>
      {children}
    </span>
  );
}
function Panorama() {
  return <div className="mc-panorama" aria-hidden="true" style={assetStyle('gatewayPanorama')} />;
}

export function MinecraftGatewayEditor(props: GatewayMessageExtensionProps) {
  useEffect(prepareFont, []);
  return (
    <div className="mc-message-editor">
      {messageChannels(props.definition, props.state, props.locale).map((channel) => (
        <MessageScreen key={channel.id} {...props} channel={channel} />
      ))}
    </div>
  );
}

function MessageScreen({
  channel,
  state,
  definition,
  locale,
  overrides,
  readOnly,
  onChange,
  onReset,
}: GatewayMessageExtensionProps & {
  channel: GatewayMessageExtensionProps['definition']['channels'][number];
}) {
  const t = useT();
  const editor = useRef<GatewayRichTextHandle>(null);
  const sourceField = useRef<HTMLTextAreaElement>(null);
  const [source, setSource] = useState(false);
  const [palette, setPalette] = useState(false);
  const [variableMenu, setVariableMenu] = useState(false);
  const toolbar = useRef<HTMLFieldSetElement>(null);
  const field = channel.id;
  const custom = Object.hasOwn(overrides, field);
  const value = overrides[field] ?? state.defaults[locale][field] ?? '';
  const variables = state.previewVariables[locale];
  const colors = channel.formatting?.tokens.filter((token) => token.style?.color) ?? [];
  const formats =
    channel.formatting?.tokens.filter(
      (token) => !token.style?.color && (token.style || token.reset),
    ) ?? [];
  useEffect(() => {
    if (!palette && !variableMenu) return;
    const close = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) {
        setPalette(false);
        setVariableMenu(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [palette, variableMenu]);
  const insert = (token: string) => {
    if (readOnly) return;
    if (source) {
      const node = sourceField.current;
      const start = node?.selectionStart ?? value.length;
      const end = node?.selectionEnd ?? start;
      const next = value.slice(0, start) + token + value.slice(end);
      if (next.length <= channel.maxLength) {
        onChange(field, next);
        requestAnimationFrame(() => {
          node?.focus();
          node?.setSelectionRange(start + token.length, start + token.length);
        });
      }
    } else editor.current?.insert(token);
    setPalette(false);
    setVariableMenu(false);
  };
  const content = source ? (
    <textarea
      ref={sourceField}
      className="mc-message-source"
      aria-label={channel.label[locale]}
      value={value}
      readOnly={readOnly}
      maxLength={channel.maxLength}
      rows={field === 'motd' ? 2 : 4}
      spellCheck={false}
      onChange={(event) => onChange(field, event.target.value)}
    />
  ) : (
    <GatewayRichText
      editorRef={editor}
      channel={channel}
      value={value}
      variables={variables}
      label={channel.label[locale]}
      readOnly={readOnly}
      onChange={(text) => onChange(field, text)}
    />
  );
  return (
    <section className="mc-message-section" aria-label={channel.label[locale]}>
      <header className="mc-message-heading">
        <span>{channel.label[locale]}</span>
        <span className="mc-message-inheritance">
          {t(`games.minecraft.messages.${custom ? 'custom' : 'inherited'}`)}
        </span>
        <div className="mc-message-heading-actions">
          <IconButton
            label={t(`games.minecraft.messages.${source ? 'visual' : 'source'}`)}
            pressed={source}
            onClick={() => setSource(!source)}
          >
            <CodeIcon />
          </IconButton>
          <IconButton
            label={t('automation.resetMessage')}
            disabled={readOnly || !custom}
            onClick={() => onReset(field)}
          >
            ↺
          </IconButton>
        </div>
      </header>
      {field === 'motd' ? (
        <div className="mc-server-list mc-game-surface">
          <Panorama />
          <div className="mc-list-title" aria-hidden="true">
            {t('games.minecraft.messages.multiplayer')}
          </div>
          <div className="mc-list-viewport" style={assetStyle('gatewayListMenu')}>
            <div
              className="mc-list-separator mc-list-separator-top"
              aria-hidden="true"
              style={assetStyle('gatewayHeader')}
            />
            <div className="mc-server-entry">
              <div
                aria-hidden="true"
                className="mc-server-icon"
                style={assetStyle('gatewayServerIcon')}
              />
              <div className="mc-server-description">
                <div className="mc-server-name">{variables.server}</div>
                {content}
              </div>
              <div className="mc-server-status" aria-hidden="true">
                <span className="mc-server-players">
                  —<span>/</span>—
                </span>
                <div className="mc-server-signal" style={assetStyle('gatewayPing')} />
              </div>
            </div>
            <div
              className="mc-list-separator mc-list-separator-bottom"
              aria-hidden="true"
              style={assetStyle('gatewayFooter')}
            />
          </div>
          <div className="mc-list-actions" aria-hidden="true">
            <div className="mc-list-actions-primary">
              {(['join', 'direct', 'add'] as const).map((action) => (
                <ClientButton key={action}>{t(`games.minecraft.messages.${action}`)}</ClientButton>
              ))}
            </div>
            <div className="mc-list-actions-secondary">
              {(['edit', 'delete', 'refresh', 'cancel'] as const).map((action) => (
                <ClientButton key={action}>{t(`games.minecraft.messages.${action}`)}</ClientButton>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mc-disconnect mc-game-surface">
          <Panorama />
          <div className="mc-disconnect-content">
            <div className="mc-disconnect-title">{t('games.minecraft.messages.disconnected')}</div>
            {content}
            <div className="mc-disconnect-return" aria-hidden="true">
              <ClientButton>{t('games.minecraft.messages.back')}</ClientButton>
            </div>
          </div>
        </div>
      )}
      <fieldset
        ref={toolbar}
        className="mc-message-toolbar"
        aria-label={t('automation.formatting')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && (palette || variableMenu)) {
            event.stopPropagation();
            setPalette(false);
            setVariableMenu(false);
            editor.current?.focus();
          }
        }}
      >
        <div className="mc-message-menu-anchor">
          <IconButton
            label={t('games.minecraft.messages.colors')}
            disabled={readOnly}
            expanded={palette}
            onClick={() => {
              setPalette(!palette);
              setVariableMenu(false);
            }}
          >
            <span className="mc-color-symbol">A</span>
          </IconButton>
          {palette && (
            <fieldset
              className="mc-color-palette"
              aria-label={t('games.minecraft.messages.colors')}
            >
              {colors.map((token) => (
                <Tooltip key={token.value} content={token.label[locale]}>
                  <button
                    type="button"
                    className="mc-color-swatch"
                    style={{ backgroundColor: token.style?.color }}
                    aria-label={token.label[locale]}
                    onClick={() => insert(token.value)}
                  />
                </Tooltip>
              ))}
            </fieldset>
          )}
        </div>
        {formats.map((token) => (
          <IconButton
            key={token.value}
            label={token.label[locale]}
            disabled={readOnly}
            onClick={() => insert(token.value)}
          >
            {token.style?.bold ? (
              <b>B</b>
            ) : token.style?.italic ? (
              <i>I</i>
            ) : token.style?.underline ? (
              <u>U</u>
            ) : token.style?.strike ? (
              <s>S</s>
            ) : (
              <span className="mc-clear-format">T×</span>
            )}
          </IconButton>
        ))}
        <span className="mc-toolbar-divider" />
        <IconButton
          label={t('games.minecraft.messages.undo')}
          disabled={readOnly || source}
          onClick={() => editor.current?.undo()}
        >
          ↶
        </IconButton>
        <IconButton
          label={t('games.minecraft.messages.redo')}
          disabled={readOnly || source}
          onClick={() => editor.current?.redo()}
        >
          ↷
        </IconButton>
        <div className="mc-message-menu-anchor">
          <IconButton
            label={t('games.minecraft.messages.variables')}
            disabled={readOnly}
            expanded={variableMenu}
            onClick={() => {
              setVariableMenu(!variableMenu);
              setPalette(false);
            }}
          >
            {'{ }'}
          </IconButton>
          {variableMenu && (
            <fieldset
              className="mc-variable-menu"
              aria-label={t('games.minecraft.messages.variables')}
            >
              {definition.variables.map((variable) => (
                <button key={variable.id} type="button" onClick={() => insert(`{${variable.id}}`)}>
                  {variable.label[locale]}
                </button>
              ))}
            </fieldset>
          )}
        </div>
        <span className="mc-message-length">
          {value.length}/{channel.maxLength}
        </span>
      </fieldset>
    </section>
  );
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
  expanded,
}: {
  label: string;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="mc-editor-icon"
        aria-label={label}
        aria-pressed={pressed}
        aria-expanded={expanded}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}
function CodeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" />
    </svg>
  );
}
