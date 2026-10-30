import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';

export type MessageChannel = GatewayMessageDefinition['channels'][number];
export type MessageState = GatewayMessageDefinition['states'][number];
type MessageStyle = {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};
export interface MessagePreviewRun {
  text: string;
  style: MessageStyle;
}

export function messageChannels(
  definition: GatewayMessageDefinition,
  state: MessageState,
  locale: 'en' | 'it',
) {
  return definition.channels.filter((channel) => Object.hasOwn(state.defaults[locale], channel.id));
}

export function messagePreview(
  value: string,
  variables: Record<string, string>,
  channel: MessageChannel,
): MessagePreviewRun[] {
  const expanded = value.replace(/\{([^{}]+)\}/g, (placeholder, id: string) =>
    Object.hasOwn(variables, id) ? (variables[id] ?? placeholder) : placeholder,
  );
  const tokens = (channel.formatting?.tokens ?? [])
    .filter((token) => token.value.length > 0)
    .toSorted((left, right) => right.value.length - left.value.length);
  const runs: MessagePreviewRun[] = [];
  let style: MessageStyle = {};
  let start = 0;
  for (let index = 0; index < expanded.length; ) {
    const token = tokens.find((item) => {
      const candidate = expanded.slice(index, index + item.value.length);
      return channel.formatting?.caseInsensitive
        ? candidate.toLowerCase() === item.value.toLowerCase()
        : candidate === item.value;
    });
    if (!token) {
      index += 1;
      continue;
    }
    if (index > start) runs.push({ text: expanded.slice(start, index), style });
    style = token.reset ? {} : { ...style };
    // Map only the declarative style vocabulary; never accept arbitrary CSS or HTML.
    if (token.style) {
      if (token.style.color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(token.style.color))
        style.color = token.style.color;
      for (const property of ['bold', 'italic', 'underline', 'strike'] as const) {
        if (typeof token.style[property] === 'boolean') style[property] = token.style[property];
      }
    }
    index += token.value.length;
    start = index;
  }
  if (start < expanded.length) runs.push({ text: expanded.slice(start), style });
  return runs;
}
