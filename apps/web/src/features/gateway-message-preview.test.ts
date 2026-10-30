import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import { type MessageChannel, messageChannels, messagePreview } from './gateway-message-preview.js';

const label = { en: 'Notice', it: 'Avviso' };
const plain: MessageChannel = { id: 'notice', label, maxLength: 80, multiline: false };
const formatted: MessageChannel = {
  ...plain,
  formatting: {
    tokens: [
      { value: '[b]', label, style: { bold: true } },
      { value: '[red]', label, reset: true, style: { color: '#ff0000' } },
      { value: '[u]', label, style: { underline: true, strike: true, italic: true } },
      { value: '[reset]', label, reset: true },
    ],
  },
};

describe('descriptor-driven gateway previews', () => {
  it('keeps plain channels literal, including legacy formatting and HTML', () => {
    const value = '§a[b]<script>example</script>';
    expect(messagePreview(value, {}, plain)).toEqual([{ text: value, style: {} }]);
  });

  it('substitutes arbitrary declared preview variables without guessing unknown values', () => {
    expect(
      messagePreview(
        '{queue-position} / {world} {unknown} {constructor}',
        {
          'queue-position': '3',
          world: '<b>Test</b>',
        },
        plain,
      ),
    ).toEqual([{ text: '3 / <b>Test</b> {unknown} {constructor}', style: {} }]);
  });

  it('applies only declared tokens, accumulates supported styles and resets on request', () => {
    expect(messagePreview('a[b]b[red]c[u]d[reset]e[unknown]', {}, formatted)).toEqual([
      { text: 'a', style: {} },
      { text: 'b', style: { bold: true } },
      { text: 'c', style: { color: '#ff0000' } },
      { text: 'd', style: { color: '#ff0000', underline: true, strike: true, italic: true } },
      { text: 'e[unknown]', style: {} },
    ]);
  });

  it('matches literal longest tokens without regex interpretation or empty-token loops', () => {
    const channel: MessageChannel = {
      ...plain,
      formatting: {
        tokens: [
          { value: '', label, style: { bold: true } },
          { value: '.', label, style: { bold: true } },
          { value: '.*', label, style: { italic: true } },
        ],
      },
    };
    expect(messagePreview('.*yes', {}, channel)).toEqual([
      { text: 'yes', style: { italic: true } },
    ]);
  });

  it('rejects unsafe colors even if descriptor validation was bypassed', () => {
    const channel: MessageChannel = {
      ...plain,
      formatting: { tokens: [{ value: '[x]', label, style: { color: 'url(example)' } }] },
    };
    expect(messagePreview('[x]safe', {}, channel)).toEqual([{ text: 'safe', style: {} }]);
  });

  it('matches token case only when the descriptor requests it', () => {
    expect(messagePreview('[B]plain', {}, formatted)).toEqual([{ text: '[B]plain', style: {} }]);
    expect(
      messagePreview(
        '[B]bold',
        {},
        {
          ...formatted,
          formatting: { tokens: formatted.formatting?.tokens ?? [], caseInsensitive: true },
        },
      ),
    ).toEqual([{ text: 'bold', style: { bold: true } }]);
  });

  it('discovers arbitrary channels from each state, including an empty default', () => {
    const definition: GatewayMessageDefinition = {
      version: 1,
      channels: [plain, { ...plain, id: 'banner' }, { ...plain, id: 'third-channel' }],
      variables: [],
      states: [
        {
          id: 'queued',
          label,
          defaults: {
            en: { notice: '', 'third-channel': 'Wait' },
            it: { notice: '', 'third-channel': 'Attendi' },
          },
          previewVariables: { en: {}, it: {} },
        },
        {
          id: 'active',
          label,
          defaults: { en: { banner: 'Ready' }, it: { banner: 'Pronto' } },
          previewVariables: { en: {}, it: {} },
        },
      ],
    };
    const state = definition.states[0];
    if (!state) throw new Error('Missing fixture state');
    expect(messageChannels(definition, state, 'en').map((channel) => channel.id)).toEqual([
      'notice',
      'third-channel',
    ]);
    const active = definition.states[1];
    if (!active) throw new Error('Missing active fixture state');
    expect(messageChannels(definition, active, 'it').map((channel) => channel.id)).toEqual([
      'banner',
    ]);
  });
});
