import type { MessageChannel, MessagePreviewRun } from './gateway-message-preview.js';

type FormattingToken = NonNullable<MessageChannel['formatting']>['tokens'][number];
export interface RichMessagePart {
  start: number;
  end: number;
  source: string;
  text: string;
  kind: 'text' | 'format' | 'variable';
  style: MessagePreviewRun['style'];
}
export interface RichMessageSelection {
  start: number;
  end: number;
}
export interface RichMessageEdit {
  value: string;
  selection: RichMessageSelection;
}

function orderedFormattingTokens(channel: MessageChannel) {
  return (channel.formatting?.tokens ?? [])
    .filter((token) => token.value.length > 0)
    .toSorted((left, right) => right.value.length - left.value.length);
}
function matchingToken(
  value: string,
  channel: MessageChannel,
  tokens = orderedFormattingTokens(channel),
) {
  return tokens.find((token) => {
    const prefix = value.slice(0, token.value.length);
    return channel.formatting?.caseInsensitive
      ? prefix.toLowerCase() === token.value.toLowerCase()
      : prefix === token.value;
  });
}

function applyStyle(style: RichMessagePart['style'], token: FormattingToken) {
  const next = token.reset ? {} : { ...style };
  if (token.style?.color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(token.style.color))
    next.color = token.style.color;
  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
    if (typeof token.style?.[key] === 'boolean') next[key] = token.style[key];
  }
  return next;
}

/** Keep exact source offsets: preview expansions must never become saved text. */
export function richMessageParts(
  value: string,
  channel: MessageChannel,
  variables: Record<string, string>,
): RichMessagePart[] {
  const parts: RichMessagePart[] = [];
  const tokens = orderedFormattingTokens(channel);
  let style: RichMessagePart['style'] = {};
  for (let index = 0; index < value.length; ) {
    const tail = value.slice(index);
    const token = matchingToken(tail, channel, tokens);
    const variable = /^\{([^{}]+)\}/.exec(tail);
    if (token) {
      style = applyStyle(style, token);
      parts.push({
        start: index,
        end: index + token.value.length,
        source: tail.slice(0, token.value.length),
        text: '',
        kind: 'format',
        style,
      });
      index += token.value.length;
    } else if (variable && Object.hasOwn(variables, variable[1] ?? '')) {
      const source = variable[0];
      parts.push({
        start: index,
        end: index + source.length,
        source,
        text: variables[variable[1] ?? ''] || source,
        kind: 'variable',
        style,
      });
      index += source.length;
    } else {
      const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
      const previous = parts.at(-1);
      if (previous?.kind === 'text' && previous.style === style) {
        previous.source += character;
        previous.text += character;
        previous.end += character.length;
      } else {
        parts.push({
          start: index,
          end: index + character.length,
          source: character,
          text: character,
          kind: 'text',
          style,
        });
      }
      index += character.length;
    }
  }
  return parts;
}

export function richMessageSelection(
  value: string,
  selection: RichMessageSelection,
  channel: MessageChannel,
  variables: Record<string, string>,
): RichMessageSelection {
  let start = Math.max(0, Math.min(value.length, selection.start, selection.end));
  let end = Math.max(0, Math.min(value.length, Math.max(selection.start, selection.end)));
  const collapsed = start === end;
  for (const part of richMessageParts(value, channel, variables)) {
    if (part.kind === 'text') continue;
    if (start > part.start && start < part.end) start = collapsed ? part.end : part.start;
    if (end > part.start && end < part.end) end = part.end;
  }
  // Browser offsets are UTF-16; never split a supplementary character.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start] ?? '')) start -= 1;
  if (end > 0 && /[\uDC00-\uDFFF]/u.test(value[end] ?? '')) end += 1;
  return { start, end };
}

export function replaceRichMessage(
  value: string,
  selection: RichMessageSelection,
  inserted: string,
  channel: MessageChannel,
  variables: Record<string, string>,
): RichMessageEdit | undefined {
  const range = richMessageSelection(value, selection, channel, variables);
  const text = inserted
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip unsupported control characters from pasted text.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n/g, channel.multiline ? '\n' : ' ');
  const next = value.slice(0, range.start) + text + value.slice(range.end);
  if (next.length > channel.maxLength) return undefined;
  const caret = range.start + text.length;
  return { value: next, selection: { start: caret, end: caret } };
}

/** Apply toolbar formatting to every selected run, preserving other styles and
 * restoring the original style after the selection. No rendered value is saved. */
export function insertRichMessageToken(
  value: string,
  selection: RichMessageSelection,
  inserted: string,
  channel: MessageChannel,
  variables: Record<string, string>,
): RichMessageEdit | undefined {
  const range = richMessageSelection(value, selection, channel, variables);
  const token = matchingToken(inserted, channel);
  if (!token || token.value.length !== inserted.length || range.start === range.end)
    return replaceRichMessage(value, range, inserted, channel, variables);
  const tokens = orderedFormattingTokens(channel);
  const reset = tokens.find((item) => item.reset && !item.style)?.value;
  const clear = token.reset && !token.style;
  const affected = Object.keys(token.style ?? {}) as Array<keyof RichMessagePart['style']>;
  let originalStyle: RichMessagePart['style'] = {};
  let originalSequence = '';
  let opaqueSequence = '';
  const trackOriginal = (part: RichMessagePart) => {
    const current = matchingToken(part.source, channel, tokens);
    if (!current) return;
    originalStyle = applyStyle(originalStyle, current);
    if (current.reset) {
      originalSequence = '';
      opaqueSequence = '';
    }
    originalSequence += part.source;
    if (!current.style && !current.reset) opaqueSequence += part.source;
  };
  const applyChosen = () => {
    if (clear || !token.reset) return inserted;
    // Color codes reset Minecraft decoration flags. Reapply the flags that were
    // active in this original run, while leaving the chosen color authoritative.
    let restoreOther = '';
    const desired = { ...originalStyle, ...token.style };
    let restored = applyStyle({}, token);
    for (const key of ['color', 'bold', 'italic', 'underline', 'strike'] as const) {
      if (affected.includes(key) || !desired[key] || restored[key] === desired[key]) continue;
      const candidate = tokens.find(
        (item) =>
          !item.reset &&
          item.style?.[key] === desired[key] &&
          Object.entries(item.style ?? {}).every(
            ([property, setting]) => desired[property as keyof typeof desired] === setting,
          ),
      );
      if (candidate) {
        restoreOther += candidate.value;
        restored = applyStyle(restored, candidate);
      }
    }
    return inserted + restoreOther + opaqueSequence;
  };
  const parts = richMessageParts(value, channel, variables);
  for (const part of parts) {
    if (part.end > range.start) break;
    if (part.kind === 'format') trackOriginal(part);
  }
  let replacement = applyChosen();
  const selectedStart = range.start + replacement.length;
  for (const part of parts) {
    if (part.end <= range.start || part.start >= range.end) continue;
    if (part.kind !== 'format') {
      replacement += value.slice(Math.max(part.start, range.start), Math.min(part.end, range.end));
      continue;
    }
    trackOriginal(part);
    if (clear) continue;
    const current = matchingToken(part.source, channel, tokens);
    if (!current) continue;
    const touchesChosen = affected.some((key) => current.style?.[key] !== undefined);
    if (current.reset && token.reset) {
      replacement += applyChosen();
    } else if (current.reset || touchesChosen) {
      replacement += part.source + applyChosen();
    } else {
      replacement += part.source;
    }
  }
  const selectedEnd = range.start + replacement.length;
  if (range.end < value.length && reset) replacement += reset + originalSequence;
  const edit = replaceRichMessage(value, range, replacement, channel, variables);
  if (!edit) return undefined;
  return { value: edit.value, selection: { start: selectedStart, end: selectedEnd } };
}

export function deleteRichMessage(
  value: string,
  selection: RichMessageSelection,
  direction: 'backward' | 'forward',
  channel: MessageChannel,
  variables: Record<string, string>,
): RichMessageEdit | undefined {
  const range = richMessageSelection(value, selection, channel, variables);
  if (range.start === range.end) {
    const visible = richMessageParts(value, channel, variables).filter(
      (part) => part.kind !== 'format',
    );
    const part =
      direction === 'backward'
        ? visible.findLast((item) => item.start < range.start)
        : visible.find((item) => item.end > range.end);
    if (!part) return undefined;
    if (part.kind === 'variable') {
      range.start = Math.min(range.start, part.start);
      range.end = Math.max(range.end, part.end);
    } else {
      const segments = [
        ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part.text),
      ];
      if (direction === 'backward') {
        const segment = segments.findLast((item) => part.start + item.index < range.start);
        if (segment) range.start = part.start + segment.index;
      } else {
        const segment = segments.find(
          (item) => part.start + item.index + item.segment.length > range.end,
        );
        if (segment) range.end = part.start + segment.index + segment.segment.length;
      }
    }
  }
  return replaceRichMessage(value, range, '', channel, variables);
}
