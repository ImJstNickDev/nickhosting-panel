import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sftpActivityConfiguration } from '../../../deploy/sftp-activity-config.js';
import { sftpEventAuditId, sftpEventSchema } from './sftp-events.js';

describe('SFTPGo 2.7.6 event contract and offline configuration', () => {
  const config = sftpActivityConfiguration({
    callbackUrl: 'http://api:3001/v1/provider-events/sftpgo',
    instanceId: randomUUID(),
    secret: 'a'.repeat(64),
  });
  const values = {
    Name: 'test_user',
    UID: 'fs_event_123456',
    Timestamp: '1792236000000000001',
    Event: 'rename',
    Status: '1',
    VirtualPath: '/folder/quoted" file.txt',
    VirtualTargetPath: '/folder/renamed.txt',
    FileSize: '12',
    Protocol: 'SFTP',
  };
  function render(index: number) {
    const action = config.actions[index];
    if (!action) throw new Error('missing action');
    // Pinned upstream uses JSONEscape for string placeholders when Content-Type is JSON.
    return JSON.parse(
      action.options.http_config.body.replace(
        /\{\{\.(\w+)\}\}/g,
        (_, field: keyof typeof values) => {
          const value = values[field];
          return ['Status', 'FileSize'].includes(field)
            ? value
            : JSON.stringify(value).slice(1, -1);
        },
      ),
    );
  }
  it('emits escaped JSON with nanosecond timestamp preserved', () => {
    const event = sftpEventSchema.parse(render(0));
    expect(event.virtualPath).toBe(values.VirtualPath);
    expect(event.timestamp).toBe(values.Timestamp);
    expect(event.fileSize).toBe(12);
  });
  it('performs a bounded failure redelivery without changing operation identity/outcome', () => {
    const event = sftpEventSchema.parse(render(0));
    const retry = sftpEventSchema.parse(render(1));
    expect(retry).toEqual(event);
    expect(sftpEventAuditId(retry)).toBe(sftpEventAuditId(event));
    expect(config.rule.actions.map((action) => action.relation_options)).toEqual([
      { execute_sync: false, stop_on_failure: false, is_failure_action: false },
      { execute_sync: false, stop_on_failure: false, is_failure_action: true },
    ]);
  });
  it('never transmits physical paths, IP, file data, credentials or provider errors', () => {
    expect(config.actions[0]?.options.http_config.body).not.toMatch(
      /FsPath|FsTargetPath|Password|ErrorString|IP|ObjectData/,
    );
    expect(config.rule.conditions.fs_events).not.toContain('pre-upload');
  });
  it('keeps retries immutable and independent operations distinct', () => {
    const event = sftpEventSchema.parse(render(0));
    expect(sftpEventAuditId({ ...event, status: 2 })).toBe(sftpEventAuditId(event));
    expect(sftpEventAuditId({ ...event, eventId: randomUUID() })).not.toBe(sftpEventAuditId(event));
  });
});
