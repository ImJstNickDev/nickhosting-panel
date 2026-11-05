import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { satisfactorySaveHeaderSchema, satisfactorySessionsSchema } from './api-schemas.js';
import { satisfactoryEnumerationMaxBytes } from './response-limits.js';

type Path = Array<string | number>;
type Frame = {
  value: Record<string, unknown> | unknown[];
  path: Path;
  state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'valueOrEnd' | 'commaOrEnd';
  key?: string;
};
export type SatisfactorySessionEvent =
  | { type: 'session'; index: number; sessionName: string }
  | { type: 'save'; sessionIndex: number; save: z.infer<typeof satisfactorySaveHeaderSchema> }
  | { type: 'complete'; data: z.infer<typeof satisfactorySessionsSchema> };

/** Incremental JSON grammar, bounded before allocation. Completed save headers
 * are provisional until the entire native envelope has passed validation. */
class SessionsParser {
  private stack: Frame[] = [];
  private token = '';
  private tokenType: 'string' | 'atom' | undefined;
  private escaped = false;
  private root: unknown;
  private finished = false;
  private saves = 0;
  private values = 0;
  private namedSessions = new Set<number>();
  private waitingSaves = new Map<
    number,
    Array<Extract<SatisfactorySessionEvent, { type: 'save' }>>
  >();
  readonly events: SatisfactorySessionEvent[] = [];
  private fail(): never {
    throw new DomainError('integration_unavailable');
  }
  private path(): Path {
    const frame = this.stack.at(-1);
    if (!frame) return [];
    return [...frame.path, Array.isArray(frame.value) ? frame.value.length : (frame.key as string)];
  }
  private accept(value: unknown, path: Path): void {
    if (++this.values > 600000) this.fail();
    const frame = this.stack.at(-1);
    if (!frame) {
      if (this.finished) this.fail();
      this.root = value;
      this.finished = true;
    } else {
      if (frame.state !== 'value' && frame.state !== 'valueOrEnd') this.fail();
      if (Array.isArray(frame.value)) {
        if (frame.value.length >= (frame.path.join('.') === 'data.sessions' ? 1024 : 4096))
          this.fail();
        frame.value.push(value);
      } else {
        frame.value[frame.key as string] = value;
        delete frame.key;
      }
      frame.state = 'commaOrEnd';
    }
    if (
      path.length === 4 &&
      path[0] === 'data' &&
      path[1] === 'sessions' &&
      path[3] === 'sessionName'
    ) {
      const sessionName = z.string().max(4096).parse(value);
      const index = path[2] as number;
      this.namedSessions.add(index);
      this.events.push({ type: 'session', index, sessionName });
      this.events.push(...(this.waitingSaves.get(index) ?? []));
      this.waitingSaves.delete(index);
    }
    if (
      path.length === 5 &&
      path[0] === 'data' &&
      path[1] === 'sessions' &&
      path[3] === 'saveHeaders'
    ) {
      if (++this.saves > 32768) this.fail();
      const sessionIndex = path[2] as number;
      const event = {
        type: 'save' as const,
        sessionIndex,
        save: satisfactorySaveHeaderSchema.parse(value),
      };
      if (this.namedSessions.has(sessionIndex)) this.events.push(event);
      else {
        const waiting = this.waitingSaves.get(sessionIndex) ?? [];
        waiting.push(event);
        this.waitingSaves.set(sessionIndex, waiting);
      }
    }
  }
  private finishToken(): void {
    let value: unknown;
    try {
      value = JSON.parse(this.token);
    } catch {
      this.fail();
    }
    const frame = this.stack.at(-1);
    if (frame && (frame.state === 'keyOrEnd' || frame.state === 'key')) {
      if (
        this.tokenType !== 'string' ||
        typeof value !== 'string' ||
        Object.hasOwn(frame.value, value)
      )
        this.fail();
      frame.key = value;
      frame.state = 'colon';
    } else this.accept(value, this.path());
    this.token = '';
    this.tokenType = undefined;
  }
  push(text: string): void {
    for (const character of text) this.character(character);
  }
  private character(c: string): void {
    if (this.tokenType) {
      if (this.tokenType === 'atom' && /[\s,\]}]/.test(c)) {
        this.finishToken();
        this.character(c);
        return;
      }
      this.token += c;
      if (this.token.length > 128 * 1024) this.fail();
      if (this.tokenType === 'string') {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.finishToken();
      }
      return;
    }
    if (/\s/.test(c)) {
      if (!/[\x20\t\r\n]/.test(c)) this.fail();
      return;
    }
    const frame = this.stack.at(-1);
    if (c === '}' || c === ']') {
      if (
        !frame ||
        Array.isArray(frame.value) !== (c === ']') ||
        !['commaOrEnd', 'keyOrEnd', 'valueOrEnd'].includes(frame.state)
      )
        this.fail();
      this.stack.pop();
      this.accept(frame.value, frame.path);
      return;
    }
    if (frame?.state === 'colon') {
      if (c !== ':') this.fail();
      frame.state = 'value';
      return;
    }
    if (frame?.state === 'commaOrEnd') {
      if (c !== ',') this.fail();
      frame.state = Array.isArray(frame.value) ? 'value' : 'key';
      return;
    }
    if (this.finished && !frame) this.fail();
    if (frame && ['key', 'keyOrEnd'].includes(frame.state) && c !== '"') this.fail();
    if (c === '{' || c === '[') {
      if (this.stack.length >= 16) this.fail();
      this.stack.push({
        value: c === '[' ? [] : (Object.create(null) as Record<string, unknown>),
        path: this.path(),
        state: c === '[' ? 'valueOrEnd' : 'keyOrEnd',
      });
    } else if (c === '"') {
      this.token = c;
      this.tokenType = 'string';
    } else if (/[-0-9tfn]/.test(c)) {
      this.token = c;
      this.tokenType = 'atom';
    } else this.fail();
  }
  end(): z.infer<typeof satisfactorySessionsSchema> {
    if (this.tokenType === 'atom') this.finishToken();
    if (this.stack.length || this.tokenType || !this.finished) this.fail();
    return z
      .object({ data: satisfactorySessionsSchema, errorCode: z.never().optional() })
      .parse(this.root).data;
  }
}
export async function* streamSatisfactorySessions(
  bytes: AsyncIterable<Uint8Array>,
): AsyncGenerator<SatisfactorySessionEvent> {
  const parser = new SessionsParser(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  for await (const chunk of bytes) {
    length += chunk.byteLength;
    if (length > satisfactoryEnumerationMaxBytes) throw new DomainError('integration_unavailable');
    parser.push(decoder.decode(chunk, { stream: true }));
    yield* parser.events.splice(0);
  }
  parser.push(decoder.decode());
  yield* parser.events.splice(0);
  yield { type: 'complete', data: parser.end() };
}
