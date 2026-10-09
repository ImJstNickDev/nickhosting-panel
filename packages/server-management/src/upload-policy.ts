import { isAbsolute, normalize } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

// A relative file path is bounded at 4,096 characters. Its UTF-8 escaped
// multipart header plus boundary/trailer is below 64 KiB, including worst-case
// four-byte Unicode; payload ingestion reserves both the spool and destination copies, never an
// overwrite credit against the old file.
export const uploadMultipartAllowanceBytes = 65_536;
const safeBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const uploadPolicySchema = z.strictObject({
  providerMaxFileBytes: safeBytes.refine(
    (n) => n > 0 && n <= Math.floor((Number.MAX_SAFE_INTEGER - uploadMultipartAllowanceBytes) / 2),
  ),
  temporaryDiskPath: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/.test(value)),
  temporaryDiskBudgetBytes: safeBytes.refine((n) => n >= uploadMultipartAllowanceBytes),
  temporaryDiskHeadroomBytes: safeBytes,
});
type UploadPolicy = z.infer<typeof uploadPolicySchema>;
export function uploadPolicyOverrides(
  env: Readonly<Record<string, string | undefined>> = {},
): Record<string, UploadPolicy | null> {
  if (env.NH_UPLOAD_POLICIES === undefined) return {};
  try {
    return z
      .record(z.uuid(), uploadPolicySchema.nullable())
      .parse(JSON.parse(env.NH_UPLOAD_POLICIES));
  } catch {
    throw new DomainError('configuration_invalid');
  }
}
export function effectiveUploadPolicy(
  host: { id: string; upload_policy: UploadPolicy | null },
  env: Readonly<Record<string, string | undefined>> = {},
): UploadPolicy | null {
  const overrides = uploadPolicyOverrides(env);
  const value = Object.hasOwn(overrides, host.id) ? overrides[host.id] : host.upload_policy;
  if (value == null) return null;
  const parsed = uploadPolicySchema.safeParse(value);
  if (!parsed.success) throw new DomainError('configuration_invalid');
  return parsed.data;
}
