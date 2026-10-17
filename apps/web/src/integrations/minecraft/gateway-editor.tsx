import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';
import {
  type MinecraftMessageAlignment,
  minecraftGlyphAdvance,
  minecraftMessageAlignment,
  minecraftUiModule,
  setMinecraftMessageAlignment,
  stripMinecraftMessageAlignment,
} from '@nickhosting/minecraft/ui';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import type { GatewayMessageExtensionProps } from '../../features/gateway-message-extension.js';
import {
  type MessageChannel,
  messageChannels,
  messagePreview,
} from '../../features/gateway-message-preview.js';
import { GatewayRichText, type GatewayRichTextHandle } from '../../features/gateway-rich-text.js';
import {
  minecraftDisconnectHeight,
  minecraftMessageLines,
  minecraftMotdWidth,
} from './gateway-message-layout.js';
import './gateway-editor.css';

// All URLs are bundled first-party module resources, never API-supplied CSS or executable code.
const assets = minecraftUiModule.assets ?? {};
let fontRequest: Promise<boolean> | undefined;
function prepareFont() {
  if (!assets.gatewayFont || typeof FontFace === 'undefined') return Promise.resolve(false);
  fontRequest ??= new FontFace('MinecraftPreview', `url(${JSON.stringify(assets.gatewayFont)})`)
    .load()
    .then((font) => {
      document.fonts.add(font);
      return true;
    })
    // A source checkout without locally supplied Mojang resources remains editable.
    .catch(() => false);
  return fontRequest;
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

function useMinecraftFont() {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let active = true;
    void prepareFont().then((ready) => {
      if (active) setFontReady(ready);
    });
    return () => {
      active = false;
    };
  }, []);
  return fontReady;
}

export function MinecraftGatewayEditor(props: GatewayMessageExtensionProps) {
  return (
    <div className="mc-message-editor">
      {messageChannels(props.definition, props.state, props.locale).map((channel) => (
        <MinecraftMessageEditor
          key={channel.id}
          channel={channel}
          locale={props.locale}
          value={
            props.overrides[channel.id] ?? props.state.defaults[props.locale][channel.id] ?? ''
          }
          onChange={(value) => props.onChange(channel.id, value)}
          readOnly={props.readOnly}
          variables={props.state.previewVariables[props.locale]}
          variableDefinitions={props.definition.variables}
          inheritance={Object.hasOwn(props.overrides, channel.id) ? 'custom' : 'inherited'}
          onReset={() => props.onReset(channel.id)}
        />
      ))}
    </div>
  );
}

export interface MinecraftMessageEditorProps {
  channel: MessageChannel;
  locale: 'en' | 'it';
  value: string;
  onChange(value: string): void;
  readOnly: boolean;
  serverName?: string;
  variables?: Record<string, string>;
  variableDefinitions?: GatewayMessageDefinition['variables'];
  inheritance?: 'custom' | 'inherited';
  onReset?(): void;
  allowAlignment?: boolean;
}
const noVariables: Record<string, string> = {};
const noVariableDefinitions: GatewayMessageDefinition['variables'] = [];

/** Shared Minecraft chrome and editing surface for real MOTDs and Gateway templates. */
export function MinecraftMessageEditor({
  channel: suppliedChannel,
  locale,
  value,
  onChange,
  readOnly,
  serverName,
  variables = noVariables,
  variableDefinitions = noVariableDefinitions,
  inheritance,
  onReset,
  allowAlignment = true,
}: MinecraftMessageEditorProps) {
  const fontReady = useMinecraftFont();
  // Alignment directives belong to Gateway templates. A real server MOTD must
  // keep any such text literal, including when editing a pre-existing value.
  const channel = useMemo(
    () =>
      !allowAlignment && suppliedChannel.formatting
        ? {
            ...suppliedChannel,
            formatting: {
              ...suppliedChannel.formatting,
              tokens: suppliedChannel.formatting.tokens.filter(
                (token) => stripMinecraftMessageAlignment(token.value) === token.value,
              ),
            },
          }
        : suppliedChannel,
    [suppliedChannel, allowAlignment],
  );
  const t = useT();
  const editor = useRef<GatewayRichTextHandle>(null);
  const sourceField = useRef<HTMLTextAreaElement>(null);
  const [source, setSource] = useState(false);
  const [palette, setPalette] = useState(false);
  const [variableMenu, setVariableMenu] = useState(false);
  const toolbar = useRef<HTMLFieldSetElement>(null);
  const field = channel.id;
  const custom = inheritance === 'custom';
  const alignment = allowAlignment && field === 'motd' ? minecraftMessageAlignment(value) : 'left';
  const surface = useRef<HTMLDivElement>(null);
  const [guide, setGuide] = useState({ lines: 0, overflow: false });
  const lineLabel = `${t('games.minecraft.messages.lineCount', { count: guide.lines })}${field === 'motd' ? ' / 2' : ''}`;
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    // Controls belong to the template, never to substituted variable values.
    const runs = messagePreview(
      allowAlignment && field === 'motd' ? stripMinecraftMessageAlignment(value) : value,
      variables,
      {
        ...channel,
        ...(channel.formatting
          ? {
              formatting: {
                ...channel.formatting,
                tokens: channel.formatting.tokens.filter(
                  (token) => stripMinecraftMessageAlignment(token.value) === token.value,
                ),
              },
            }
          : {}),
      },
    );
    const update = () => {
      const scale = Number.parseFloat(getComputedStyle(node).fontSize) / 9;
      const width = field === 'motd' ? minecraftMotdWidth : node.clientWidth / scale - 50;
      const lines = minecraftMessageLines(runs, width, minecraftGlyphAdvance).length;
      const overflow =
        field === 'motd' ? lines > 2 : minecraftDisconnectHeight(lines) > node.clientHeight / scale;
      setGuide((old) =>
        old.lines === lines && old.overflow === overflow ? old : { lines, overflow },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, variables, channel, field, allowAlignment]);
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
        onChange(next);
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
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <GatewayRichText
      editorRef={editor}
      channel={channel}
      value={value}
      variables={variables}
      label={channel.label[locale]}
      readOnly={readOnly}
      onChange={onChange}
    />
  );
  return (
    <section className="mc-message-section" aria-label={channel.label[locale]}>
      <header className="mc-message-heading">
        <span>{channel.label[locale]}</span>
        {inheritance && (
          <span className="mc-message-inheritance">
            {t(`games.minecraft.messages.${inheritance}`)}
          </span>
        )}
        <div className="mc-message-heading-actions">
          <IconButton
            label={t(`games.minecraft.messages.${source ? 'visual' : 'source'}`)}
            pressed={source}
            onClick={() => setSource(!source)}
          >
            <CodeIcon />
          </IconButton>
          {onReset && (
            <IconButton
              label={t('automation.resetMessage')}
              disabled={readOnly || (inheritance !== undefined && !custom)}
              onClick={onReset}
            >
              ↺
            </IconButton>
          )}
        </div>
      </header>
      {field === 'motd' ? (
        <div ref={surface} className="mc-server-list mc-game-surface">
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
                <div className="mc-server-name">{serverName ?? variables.server}</div>
                <div className="mc-aligned-message" style={{ textAlign: alignment }}>
                  {content}
                </div>
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
        <div
          ref={surface}
          className={`mc-disconnect mc-game-surface${guide.overflow ? ' mc-disconnect-overflow' : ''}`}
        >
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
        {allowAlignment && field === 'motd' && (
          <fieldset
            className="mc-alignment-tools"
            aria-label={t('games.minecraft.messages.alignment')}
          >
            {(['left', 'center', 'right'] as const).map((direction) => (
              <IconButton
                key={direction}
                label={t(
                  `games.minecraft.messages.align${direction[0]?.toUpperCase()}${direction.slice(1)}`,
                )}
                pressed={alignment === direction}
                disabled={
                  readOnly ||
                  setMinecraftMessageAlignment(value, direction).length > channel.maxLength
                }
                onClick={() => {
                  if (source) onChange(setMinecraftMessageAlignment(value, direction));
                  else
                    editor.current?.transform((edit) => {
                      const next = setMinecraftMessageAlignment(edit.value, direction);
                      const prefix = next.length - stripMinecraftMessageAlignment(next).length;
                      const offset = (position: number) =>
                        prefix +
                        stripMinecraftMessageAlignment(edit.value.slice(0, position)).length;
                      return {
                        value: next,
                        selection: {
                          start: Math.min(next.length, offset(edit.selection.start)),
                          end: Math.min(next.length, offset(edit.selection.end)),
                        },
                      };
                    });
                }}
              >
                <AlignIcon direction={direction} />
              </IconButton>
            ))}
          </fieldset>
        )}
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
        {variableDefinitions.length > 0 && (
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
                {variableDefinitions.map((variable) => (
                  <button
                    key={variable.id}
                    type="button"
                    onClick={() => insert(`{${variable.id}}`)}
                  >
                    {variable.label[locale]}
                  </button>
                ))}
              </fieldset>
            )}
          </div>
        )}
        <Tooltip
          content={`${t(`games.minecraft.messages.${field === 'motd' ? 'motdGuide' : 'disconnectGuide'}`)} ${t('games.minecraft.messages.measurementGuide')}${!fontReady ? ` ${t('games.minecraft.messages.fallbackGuide')}` : ''}`}
        >
          <button
            type="button"
            className={`mc-layout-count${guide.overflow ? ' mc-layout-overflow' : ''}`}
            aria-label={`${t('games.minecraft.messages.layoutGuide')}: ${lineLabel}`}
          >
            {lineLabel}
          </button>
        </Tooltip>
        <span className="mc-message-length">
          {value.length}/{channel.maxLength}
        </span>
      </fieldset>
      <div className="mc-layout-feedback" role="status" aria-live="polite">
        {guide.overflow &&
          t(`games.minecraft.messages.${field === 'motd' ? 'motdClipped' : 'disconnectClipped'}`)}
      </div>
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
function AlignIcon({ direction }: { direction: MinecraftMessageAlignment }) {
  const start = direction === 'left' ? 3 : direction === 'center' ? 6 : 9;
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d={`M3 5h18M${start} 10h12M3 15h18M${start} 20h12`} />
    </svg>
  );
}
