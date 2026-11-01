/** Historical server.properties files store these enums as numeric IDs. Keep
 * their installed representation while the UI uses the same readable choices. */
const enums: Readonly<Record<string, readonly string[]>> = {
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
};

export function minecraftPropertyEnumName(key: string, value: string): string {
  const options = enums[key];
  return options && /^[0-3]$/.test(value) ? (options[Number(value)] ?? value) : value;
}

export function minecraftPropertyEnumValue(key: string, value: string, current?: string): string {
  const options = enums[key];
  const index = options?.indexOf(value) ?? -1;
  return current !== undefined && /^[0-3]$/.test(current) && index >= 0 ? String(index) : value;
}
