import { DomainError } from '@nickhosting/core';
import type { MinecraftRuntimeProfile } from './runtime.js';

/** Core passes only evidence-gated, rollout-filtered combinations; technical evidence stays private. */
export interface MinecraftCreationChoice {
  readonly id: string;
  readonly release: string;
  readonly runtime: MinecraftRuntimeProfile;
  readonly nameKey: string;
}
export interface MinecraftModpackSelection {
  readonly provider: 'modrinth' | 'curseforge';
  readonly projectId: string;
  readonly versionId: string;
  readonly release: string;
  readonly runtime: MinecraftRuntimeProfile;
  readonly loaderVersion: string;
  readonly choiceId: string;
}
export interface MinecraftWizardField {
  readonly id: string;
  readonly labelKey: string;
  readonly kind: 'choice' | 'players' | 'boolean' | 'text' | 'resources' | 'confirmation';
  readonly required: boolean;
}
export interface MinecraftWizardDescriptor {
  readonly steps: readonly {
    readonly id: 'choose-game' | 'configure' | 'resources' | 'create';
    readonly titleKey: string;
    readonly fields: readonly MinecraftWizardField[];
  }[];
  readonly choices: readonly MinecraftCreationChoice[];
  readonly derived?: {
    readonly release: string;
    readonly runtime: MinecraftRuntimeProfile;
    readonly choiceId: string;
  };
}
export function minecraftWizard(
  choices: readonly MinecraftCreationChoice[],
  modpack?: MinecraftModpackSelection,
): MinecraftWizardDescriptor {
  const publicChoices = choices.map(({ id, release, runtime, nameKey }) => ({
    id,
    release,
    runtime,
    nameKey,
  }));
  if (new Set(publicChoices.map((item) => item.id)).size !== publicChoices.length)
    throw new DomainError('configuration_invalid');
  if (
    modpack &&
    !publicChoices.some(
      (item) =>
        item.id === modpack.choiceId &&
        item.release === modpack.release &&
        item.runtime === modpack.runtime,
    )
  )
    throw new DomainError('integration_unavailable');
  const field = (
    id: string,
    kind: MinecraftWizardField['kind'],
    required = true,
  ): MinecraftWizardField => ({
    id,
    kind,
    required,
    labelKey: `games.minecraft-java.fields.${id}`,
  });
  return {
    steps: [
      {
        id: 'choose-game',
        titleKey: 'games.minecraft-java.steps.chooseGame',
        fields: [field('game', 'choice')],
      },
      {
        id: 'configure',
        titleKey: 'games.minecraft-java.steps.configure',
        fields: [
          ...(modpack
            ? []
            : [field('runtimeVersion', 'choice'), field('modpack', 'choice', false)]),
          field('name', 'text'),
          field('operators', 'players', false),
          field('whitelist', 'players', false),
          field('whitelistEnabled', 'boolean'),
          field('hostname', 'text', false),
        ],
      },
      {
        id: 'resources',
        titleKey: 'games.minecraft-java.steps.resources',
        fields: [field('resources', 'resources')],
      },
      {
        id: 'create',
        titleKey: 'games.minecraft-java.steps.create',
        fields: [field('eulaAccepted', 'confirmation'), field('create', 'confirmation')],
      },
    ],
    choices: publicChoices,
    ...(modpack
      ? {
          derived: {
            release: modpack.release,
            runtime: modpack.runtime,
            choiceId: modpack.choiceId,
          },
        }
      : {}),
  };
}
/** A selected pack cannot silently switch an existing immutable M2 runtime or egg mapping. */
export function assertModpackRuntimeCompatible(
  current: { release: string; runtime: MinecraftRuntimeProfile; loaderVersion?: string },
  pack: MinecraftModpackSelection,
): void {
  if (
    current.release !== pack.release ||
    current.runtime !== pack.runtime ||
    current.loaderVersion !== pack.loaderVersion
  )
    throw new DomainError('conflict', 409, {
      reason: 'minecraft_modpack_runtime_change_requires_reprovision',
    });
}
