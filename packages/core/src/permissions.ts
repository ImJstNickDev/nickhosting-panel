import { DomainError } from './errors.js';

export type PlatformRole = 'owner' | 'operator' | 'user';
export type ResourceRole = 'owner' | 'manager' | 'operator' | 'viewer';
export const permissions = [
  'platform:manage',
  'settings:read',
  'settings:write',
  'invitations:manage',
  'support:start',
  'audit:read',
  'server:read',
  'server:operate',
  'server:manage',
  'jobs:read',
] as const;
export type Permission = (typeof permissions)[number];

export interface SupportMetadata {
  id: string;
  startedAt: Date;
  expiresAt: Date;
  lastActivityAt: Date;
  revokedAt: Date | null;
  reason: string;
  /** Trusted server-resolved policy, never copied from request JSON. */
  idleTtlSeconds?: number;
  absoluteTtlSeconds?: number;
}

/** Build exclusively from verified session + database records, never client JSON. */
export interface AuthContext {
  actorUserId: string;
  subjectUserId: string;
  role: PlatformRole;
  sessionType: 'regular' | 'support';
  ownerElevation: boolean;
  support?: SupportMetadata;
}

export interface ResourceScope {
  ownerUserId: string;
  memberRole?: ResourceRole;
}

export interface PermissionOptions {
  now?: Date;
  supportIdleTtlSeconds?: number;
  supportAbsoluteTtlSeconds?: number;
}

export function assertAuthContext(context: AuthContext, options: PermissionOptions = {}): void {
  if (
    !context.actorUserId ||
    !context.subjectUserId ||
    !['owner', 'operator', 'user'].includes(context.role)
  ) {
    throw new DomainError('unauthenticated');
  }
  if (context.sessionType === 'regular') {
    if (
      context.actorUserId !== context.subjectUserId ||
      context.ownerElevation ||
      context.support
    ) {
      throw new DomainError('support_invalid');
    }
    return;
  }
  const support = context.support;
  if (
    context.sessionType !== 'support' ||
    context.role !== 'owner' ||
    !context.ownerElevation ||
    !support ||
    context.actorUserId === context.subjectUserId ||
    !support.id ||
    !support.reason.trim() ||
    support.revokedAt !== null
  ) {
    throw new DomainError('support_invalid');
  }
  const now = (options.now ?? new Date()).getTime();
  const start = support.startedAt.getTime();
  const last = support.lastActivityAt.getTime();
  const expiry = support.expiresAt.getTime();
  const idleMs =
    Math.min(options.supportIdleTtlSeconds ?? support.idleTtlSeconds ?? 300, 900) * 1000;
  const absoluteMs =
    Math.min(options.supportAbsoluteTtlSeconds ?? support.absoluteTtlSeconds ?? 900, 3600) * 1000;
  if (
    ![now, start, last, expiry, idleMs, absoluteMs].every(Number.isFinite) ||
    idleMs <= 0 ||
    absoluteMs <= 0 ||
    start > now ||
    last < start ||
    last > now ||
    expiry <= start ||
    expiry <= now ||
    now - last >= idleMs ||
    now - start >= absoluteMs
  ) {
    throw new DomainError('support_expired');
  }
}

export function assertPermission(
  context: AuthContext,
  permission: Permission,
  resource?: ResourceScope,
  options: PermissionOptions = {},
): void {
  assertAuthContext(context, options);
  if (!(permissions as readonly string[]).includes(permission)) throw new DomainError('forbidden');
  // Owner operations remain attributable to the actual Owner, including support sessions.
  if (context.role === 'owner') return;
  if (context.role === 'operator' && ['settings:read', 'audit:read'].includes(permission)) return;
  if (
    !resource ||
    !['server:read', 'server:operate', 'server:manage', 'jobs:read'].includes(permission)
  ) {
    throw new DomainError('forbidden');
  }
  const membership = resource.ownerUserId === context.subjectUserId ? 'owner' : resource.memberRole;
  if (!membership) throw new DomainError('forbidden');
  if (permission === 'server:read' || permission === 'jobs:read') return;
  if (permission === 'server:operate' && ['owner', 'manager', 'operator'].includes(membership))
    return;
  if (permission === 'server:manage' && ['owner', 'manager'].includes(membership)) return;
  throw new DomainError('forbidden');
}

export function hasPermission(
  context: AuthContext,
  permission: Permission,
  resource?: ResourceScope,
  options?: PermissionOptions,
): boolean {
  try {
    assertPermission(context, permission, resource, options);
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}
