import { rcompare, satisfies, valid, validRange } from 'semver';
import { z } from 'zod';
import { satisfactoryModReferenceSchema } from './mods.js';

async function readResponse(response: Response, maximum: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('satisfactory_catalog_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error('satisfactory_catalog_response_limit');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function graphql(
  query: string,
  variables: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    maximum?: number;
  },
) {
  const response = await (options.fetch ?? fetch)('https://api.ficsit.app/v2/query', {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const parsed = z
    .object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
    .parse(await readResponse(response, options.maximum ?? 1048576));
  if (parsed.errors?.length) throw new Error('satisfactory_catalog_unavailable');
  return parsed.data;
}

export type SatisfactoryModCompatibility = 'compatible' | 'incompatible' | 'unknown';
export function satisfactoryModCompatibility(
  gameVersion: string,
  gameBuild?: number | null,
): SatisfactoryModCompatibility {
  if (gameVersion === '') return 'compatible';
  if (!gameBuild || !Number.isSafeInteger(gameBuild) || gameBuild < 1) return 'unknown';
  // SMR stores the Unreal changelist as the major component of a semver constraint.
  const range = gameVersion.replaceAll(',', ' ');
  if (!validRange(range)) return 'unknown';
  return satisfies(`${gameBuild}.0.0`, range) ? 'compatible' : 'incompatible';
}

export async function satisfactoryModVersions(
  reference: string,
  signal?: AbortSignal,
  options: {
    gameBuild?: number | null;
    includeUnsupported?: boolean;
    fetch?: typeof fetch;
  } = {},
) {
  satisfactoryModReferenceSchema.parse(reference);
  const data = await graphql(
    'query ModVersions($reference: ModReference!) { mod: getModByReference(modReference: $reference) { versions { version game_version required_on_remote changelog dependencies { mod_reference condition optional } targets { targetName } } } }',
    { reference },
    { ...options, signal, maximum: 8388608 },
  );
  const parsed = z
    .object({
      mod: z
        .object({
          versions: z
            .array(
              z.object({
                version: z.string().max(256),
                game_version: z.string().max(256),
                required_on_remote: z.boolean(),
                changelog: z.string().max(262144),
                dependencies: z
                  .array(
                    z.object({
                      mod_reference: z.string(),
                      condition: z.string(),
                      optional: z.boolean(),
                    }),
                  )
                  .max(512),
                targets: z.array(z.object({ targetName: z.string() }).nullable()).max(16),
              }),
            )
            .max(10000),
        })
        .nullable(),
    })
    .parse(data);
  if (!parsed.mod) return [];
  return parsed.mod.versions
    .filter(
      (item) =>
        options.includeUnsupported ||
        item.targets.some((target) => target?.targetName === 'LinuxServer'),
    )
    .map((item) => ({
      version: item.version,
      gameVersion: item.game_version,
      dependencies: item.dependencies.map((dependency) => ({
        mod_id: dependency.mod_reference,
        condition: dependency.condition,
        optional: dependency.optional,
      })),
      targets: item.targets.flatMap((target) => (target ? [target.targetName] : [])),
      requiredOnRemote: item.required_on_remote,
      changelog: item.changelog,
      compatibility: item.targets.some((target) => target?.targetName === 'LinuxServer')
        ? satisfactoryModCompatibility(item.game_version, options.gameBuild)
        : ('incompatible' as const),
    }))
    .sort((a, b) =>
      valid(a.version) && valid(b.version)
        ? rcompare(a.version, b.version)
        : b.version.localeCompare(a.version),
    );
}

const project = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  mod_reference: satisfactoryModReferenceSchema,
  short_description: z.string().max(16384).optional(),
  full_description: z.string().max(524288).nullable().optional(),
  logo: z.string().max(4096).nullable().optional(),
  authors: z
    .array(z.object({ user: z.object({ username: z.string().max(256) }) }))
    .max(100)
    .optional(),
  tags: z
    .array(z.object({ name: z.string().max(256) }))
    .max(100)
    .nullable()
    .optional(),
  downloads: z.number().int().nonnegative().optional(),
  last_version_date: z.string().max(128).nullable().optional(),
});
const projectFields =
  'id name mod_reference short_description logo authors { user { username } } tags { name } downloads last_version_date';
function normalizeProject(item: z.infer<typeof project>) {
  let logo: string | null = null;
  if (item.logo) {
    try {
      const url = new URL(item.logo);
      if (url.protocol === 'https:' && !url.username && !url.password) logo = url.href;
    } catch {
      /* Invalid artwork is omitted; project remains usable. */
    }
  }
  return {
    id: item.id,
    name: item.name,
    reference: item.mod_reference,
    description: item.short_description ?? '',
    logo,
    authors: [...new Set(item.authors?.map((author) => author.user.username) ?? [])],
    tags: item.tags?.map((tag) => tag.name) ?? [],
    downloads: item.downloads ?? null,
    updatedAt: item.last_version_date ?? null,
  };
}
export const satisfactoryModSearchSchema = z
  .string()
  .trim()
  .max(256)
  .refine((query) => query.length === 0 || query.length >= 3);

/** Project presence is not compatibility evidence; versions are matched against
 * LinuxServer and the installed build before the full dependency solver runs. */
export async function searchSatisfactoryMods(input: {
  query: string;
  offset?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}) {
  const query = satisfactoryModSearchSchema.parse(input.query);
  const offset = z
    .number()
    .int()
    .min(0)
    .max(100000)
    .parse(input.offset ?? 0);
  const data = await graphql(
    `query Mods($filter: ModFilter) { mods: getMods(filter: $filter) { count mods { ${projectFields} } } }`,
    {
      filter: {
        ...(query ? { search: query } : {}),
        offset,
        limit: 30,
        order: 'desc',
        order_by: 'last_version_date',
      },
    },
    input,
  );
  const parsed = z
    .object({
      mods: z.object({ count: z.number().int().nonnegative(), mods: z.array(project).max(50) }),
    })
    .parse(data);
  return { total: parsed.mods.count, offset, items: parsed.mods.mods.map(normalizeProject) };
}

export async function satisfactoryModDetails(
  reference: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
) {
  satisfactoryModReferenceSchema.parse(reference);
  const data = await graphql(
    `query ModDetails($reference: ModReference!) { mod: getModByReference(modReference: $reference) { ${projectFields} full_description } }`,
    { reference },
    options,
  );
  const parsed = z.object({ mod: project.nullable() }).parse(data);
  if (!parsed.mod) return null;
  return { ...normalizeProject(parsed.mod), fullDescription: parsed.mod.full_description ?? '' };
}

export function latestSatisfactoryModVersion(
  versions: Awaited<ReturnType<typeof satisfactoryModVersions>>,
  options: { constraint?: string; includePrerelease?: boolean } = {},
) {
  return (
    versions
      .filter(
        (item) =>
          valid(item.version) &&
          item.compatibility === 'compatible' &&
          item.targets.includes('LinuxServer') &&
          satisfies(item.version, options.constraint?.replaceAll(',', ' ') ?? '*', {
            includePrerelease: options.includePrerelease ?? false,
          }),
      )
      .sort((a, b) => rcompare(a.version, b.version))[0] ?? null
  );
}
