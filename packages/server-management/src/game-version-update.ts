import type { Database } from '@nickhosting/database';
import type { Transaction } from 'kysely';
import type { GameLifecycleContext } from './lifecycle.js';

export type VersionUpdateStage = 'backup' | 'installing' | 'verifying' | 'starting';
export type VersionUpdatePreparation =
  | { state: 'wait'; next?: Date }
  | { state: 'stop' | 'cancelled' };

/** The host owns admission, physical power evidence, backups and install effects.
 * The integration owns artifacts, player communication, progress and release proof. */
export interface GameUpdateHooks {
  prepare(
    context: GameLifecycleContext,
    stopped: () => Promise<boolean>,
    now: () => Date,
  ): Promise<VersionUpdatePreparation>;
  /** Last check before the actual power handoff. Returning false guarantees no stop was sent. */
  allowStop(context: GameLifecycleContext): Promise<boolean>;
  deferStop(tx: Transaction<Database>, jobId: string): Promise<void>;
  beforeStop(context: GameLifecycleContext): Promise<void>;
  cancelled(context: GameLifecycleContext): Promise<boolean>;
  stage(context: GameLifecycleContext, stage: VersionUpdateStage): Promise<void>;
  verify(context: GameLifecycleContext): Promise<void>;
  finish(tx: Transaction<Database>, jobId: string, success: boolean): Promise<void>;
}
