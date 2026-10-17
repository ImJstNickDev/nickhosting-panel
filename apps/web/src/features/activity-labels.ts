import type { listPlatformActivity } from '../../../../packages/server-management/src/platform-queries.js';
import type { Result } from '../api/contracts.js';

type Item = Result<typeof listPlatformActivity>['items'][number];
const eventLabels: Record<string, string> = {
  'server.console.command': 'command',
  'server.console.dispatched': 'command',
  'server.console.failed': 'command',
  'server.backup.updated': 'backupUpdated',
  'server.backup.delete_requested': 'backupDeleted',
  'server.backup.deleted': 'backupDeleted',
  'server.backup.delete_incomplete': 'backupDeleted',
  'server.sftp.issued': 'sftpIssued',
  'server.sftp.rotated': 'sftpRotated',
  'server.sftp.revoked': 'sftpRevoked',
  'server.sftp.access_revoked': 'sftpRevoked',
  'server.sftp.password_revealed': 'sftpRevealed',
  'server.member.updated': 'memberUpdated',
  'server.metadata.updated': 'settingsUpdated',
  'server.automation_consent.updated': 'automationUpdated',
  'server.dns.assigned': 'addressCreated',
  'server.dns.updated': 'addressUpdated',
  'server.dns.deleted': 'addressDeleted',
  'gateway.policy.updated': 'sleepUpdated',
  'gateway.route.configured': 'routeUpdated',
  'gateway.consent.revoked': 'automationUpdated',
  'schedule.created': 'scheduleCreated',
  'schedule.updated': 'scheduleUpdated',
  'schedule.deleted': 'scheduleDeleted',
  'schedule.stop_consent_revoked': 'automationUpdated',
};
function string(value: unknown) {
  return typeof value === 'string' ? value : '';
}
export function activityJobKey(action: string | null) {
  return action
    ? ['start', 'stop', 'restart', 'delete'].includes(action)
      ? `web.${action}`
      : `platform.${action}`
    : 'platform.operation';
}
export function activityLabelKey(item: Item) {
  if (item.kind !== 'audit') return activityJobKey(item.action);
  if (item.category === 'files') {
    const action = string(item.metadata?.action) || item.action?.split('.').at(-1) || '';
    return `activity.file.${['upload', 'download', 'delete', 'rename', 'move', 'mkdir', 'rmdir', 'copy', 'extract', 'edit', 'write', 'create'].includes(action) ? action : 'change'}`;
  }
  return `activity.event.${eventLabels[item.action ?? ''] ?? 'change'}`;
}
