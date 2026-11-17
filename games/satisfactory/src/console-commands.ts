/** Declarative command surface. New commands add a descriptor and a Core handler;
 * the Gateway never executes shell commands or interprets Unreal console syntax. */
export const satisfactoryConsoleCommands = [
  { name: 'help', usage: 'help [command]', descriptionKey: 'gateway.satisfactory.console.help' },
  { name: 'status', usage: 'status', descriptionKey: 'gateway.satisfactory.console.status' },
  { name: 'info', usage: 'info', descriptionKey: 'gateway.satisfactory.console.info' },
  { name: 'version', usage: 'version', descriptionKey: 'gateway.satisfactory.console.version' },
  { name: 'idle', usage: 'idle', descriptionKey: 'gateway.satisfactory.console.idle' },
  { name: 'start', usage: 'start', descriptionKey: 'gateway.satisfactory.console.start' },
  { name: 'stop', usage: 'stop', descriptionKey: 'gateway.satisfactory.console.stop' },
  { name: 'restart', usage: 'restart', descriptionKey: 'gateway.satisfactory.console.restart' },
  { name: 'mods', usage: 'mods', descriptionKey: 'gateway.satisfactory.console.mods' },
] as const;
export type SatisfactoryConsoleCommand = (typeof satisfactoryConsoleCommands)[number]['name'];
export function isNickHostingCommand(command: string): boolean {
  return /^\s*nickhosting(?:\s|$)/i.test(command);
}
export function parseSatisfactoryConsoleCommand(
  command: string,
):
  | { kind: 'native' }
  | { kind: 'invalid' }
  | { kind: 'command'; name: SatisfactoryConsoleCommand; helpFor?: SatisfactoryConsoleCommand } {
  if (!isNickHostingCommand(command)) return { kind: 'native' };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject line breaks and control-character command injection.
  if (command.length > 512 || /[\x00-\x1f\x7f;]/.test(command)) return { kind: 'invalid' };
  const [, rawName = 'help', ...args] = command.trim().toLowerCase().split(/\s+/);
  const descriptor = satisfactoryConsoleCommands.find((entry) => entry.name === rawName);
  if (!descriptor) return { kind: 'invalid' };
  if (descriptor.name === 'help' && args.length === 1) {
    const target = satisfactoryConsoleCommands.find((entry) => entry.name === args[0]);
    return target ? { kind: 'command', name: 'help', helpFor: target.name } : { kind: 'invalid' };
  }
  return args.length ? { kind: 'invalid' } : { kind: 'command', name: descriptor.name };
}

/** Native request keys are case-insensitive; ambiguous duplicates are rejected. */
export function readConsoleCommand(data: Record<string, unknown> | undefined): string | undefined {
  const entries = Object.entries(data ?? {});
  if (entries.length !== 1 || entries[0]?.[0].toLowerCase() !== 'command') return undefined;
  const command = entries[0][1];
  return typeof command === 'string' && command.length > 0 && command.length <= 512
    ? command
    : undefined;
}
