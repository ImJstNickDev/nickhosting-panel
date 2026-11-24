import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { OpenworldTokenExpired } from './dashboard-api.js';
import type { OpenworldNativeConnection } from './native-diagnostics.js';
import { readNativeBytes } from './native-response.js';
import type { OpenworldDifficulty } from './rules.js';

export type OpenworldRuleCommand =
  | 'role list'
  | 'role nodes'
  | `role ${'create' | 'delete' | 'parent' | 'name' | 'color' | 'homes' | 'priority' | 'add' | 'remove' | 'default' | 'assign'} ${string}`
  | `zone ${'global' | 'set' | 'preset' | 'radius' | 'priority' | 'color' | 'desc' | 'rename' | 'altitude' | 'delete' | 'member'} ${string}`
  | `border ${'space' | 'world' | 'on' | 'off' | 'radius' | 'center'} ${string}`
  | `ban ${string}`
  | 'mobs on'
  | 'mobs off'
  | 'zone list'
  | 'border info'
  | 'banlist'
  | 'difficulty'
  | `difficulty ${OpenworldDifficulty}`
  | `unban ${string}`;
type Command = OpenworldRuleCommand;
type CommandResult = { accepted: boolean; lines: string[] };
const rowsSchema = z.object({
  last: z.number().int().nonnegative().safe(),
  lines: z
    .array(z.object({ seq: z.number().int().nonnegative().safe(), text: z.string().max(65536) }))
    .max(500),
});
const record =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[INFO ?\] \[(web|server-console)\] \[(t\d+)\] ([^\r\n]+)$/;
const echo = /^web console \([^()\r\n]+\) > (.+?) {2}\(WebActions\.cpp:\d+\)$/;
const output = /^console: (.+?) {2}\(ConsoleVerbs\.cpp:\d+\)$/;
const completion =
  /^EVT event=console\.(exec|reject) req=(RULES|E7) verb=([a-z]+) {2}\(ConsoleVerbs\.cpp:\d+\)$/;

async function json(native: OpenworldNativeConnection, url: URL, body?: { command: Command }) {
  if (!native.token) throw new DomainError('integration_unavailable');
  try {
    const response = await native.fetcher(url, {
      method: body ? 'POST' : 'GET',
      signal: native.signal,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'X-OW-Token': native.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new OpenworldTokenExpired();
      if (response.status === 404) throw new DomainError('game_request_unsupported');
      throw new DomainError('integration_unavailable');
    }
    return JSON.parse(
      new TextDecoder().decode(await readNativeBytes(response, body ? 8192 : 1024 * 1024)),
    );
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}

export async function ruleReplies(
  native: OpenworldNativeConnection,
  commands: readonly Command[],
  beforeDispatch?: () => Promise<void>,
) {
  const url = new URL('/api/live/console', native.origin);
  const first = new URL(url);
  first.searchParams.set('limit', '1');
  const start = rowsSchema.safeParse(await json(native, first));
  if (!start.success) throw new DomainError('integration_unavailable');
  let after = start.data.last;
  if (beforeDispatch) await beforeDispatch();
  for (const command of commands) {
    const ack = await json(native, url, { command });
    if (ack?.ok !== true) throw new DomainError('integration_unavailable');
  }
  // The HTTP acknowledgement only queues a command. A contiguous frame from the same
  // native thread links its web echo, console output and completion event.
  const replies = new Map<Command, CommandResult>();
  let active: { cmd: Command; thread: string; lines: string[] } | null = null;
  for (let attempt = 0; attempt < 8 && replies.size < commands.length; attempt++) {
    const next = new URL(url);
    next.searchParams.set('after', String(after));
    next.searchParams.set('limit', '500');
    const page = rowsSchema.safeParse(await json(native, next));
    if (!page.success) throw new DomainError('integration_unavailable');
    for (const row of page.data.lines) {
      if (row.seq <= after) continue;
      if (row.seq !== after + 1) active = null;
      after = row.seq;
      const r = record.exec(row.text);
      if (!r) continue;
      const [, component, thread, msg] = r;
      if (!thread || !msg) continue;
      if (component === 'web') {
        const verb = echo.exec(msg)?.[1];
        if (verb) {
          const cmd = commands.find((c) => c === verb);
          active = cmd ? { cmd, thread, lines: [] } : null;
        }
      } else if (active && active.thread === thread) {
        const end = completion.exec(msg);
        if (end) {
          if (
            end[3] === active.cmd.split(' ')[0] &&
            end[2] === (end[3] === 'mobs' ? 'E7' : 'RULES')
          )
            replies.set(active.cmd, { accepted: end[1] === 'exec', lines: active.lines });
          active = null;
        } else {
          const line = output.exec(msg)?.[1];
          if (line) active.lines.push(line);
        }
      }
    }
    if (replies.size < commands.length && attempt < 7 && page.data.lines.length < 500)
      await new Promise((resolve) => setTimeout(resolve, 45));
  }
  return replies;
}

export async function readNaturalSpawning(native: OpenworldNativeConnection) {
  try {
    const status = await json(native, new URL('/api/live/status', native.origin));
    return typeof status?.entities?.naturalSpawning === 'boolean'
      ? (status.entities.naturalSpawning as boolean)
      : null;
  } catch (error) {
    if (error instanceof OpenworldTokenExpired || !(error instanceof DomainError)) throw error;
    return null;
  }
}
