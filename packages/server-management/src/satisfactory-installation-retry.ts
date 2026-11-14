/** Only the known Steam metadata race is eligible; never infer it from generic
 * failure, absent files, or a log retained from an earlier installer attempt. */
export function satisfactoryInstallerRetryable(
  logs: readonly { at: string; text: string }[],
  startedAt: Date | null,
): boolean {
  if (!startedAt) return false;
  return logs.some(
    (entry) =>
      typeof entry?.at === 'string' &&
      typeof entry?.text === 'string' &&
      Date.parse(entry.at) >= startedAt.getTime() &&
      /ERROR! Failed to install app '1690800' \(Missing configuration\)/.test(entry.text),
  );
}
