import { describe, expect, it, vi } from 'vitest';
import {
  createMinecraftIdentityProvider,
  editMinecraftProperties,
  minecraftAvatarUrl,
  minecraftUuid,
  parseMinecraftProperties,
  planMinecraftPlayerList,
  planMinecraftWorldImport,
  planMinecraftWorldSelection,
  verifyMinecraftPlayer,
} from './management.js';
import { assertModpackRuntimeCompatible, minecraftWizard } from './wizard.js';

const uuid = '12345678-1234-4234-9234-123456789abc';
const player = {
  uuid,
  name: 'Example_1',
  source: 'mojang' as const,
  verifiedAt: '2026-10-10T00:00:00.000Z',
};
describe('Minecraft properties plans', () => {
  it('preserves installed numeric or named enum representation when applying UI choices', () => {
    for (const [release, original, expected] of [
      ['1.5.2', 'difficulty=1\ngamemode=0\n', { difficulty: '3', gamemode: '2' }],
      [
        '26.1',
        'difficulty=easy\ngamemode=survival\n',
        { difficulty: 'hard', gamemode: 'adventure' },
      ],
    ] as const) {
      const result = editMinecraftProperties(
        `${original}motd=Unchanged\n`,
        { difficulty: 'hard', gamemode: 'adventure' },
        { release, supportedKeys: ['difficulty', 'gamemode', 'motd'] },
      );
      expect(parseMinecraftProperties(result.content)).toEqual({ ...expected, motd: 'Unchanged' });
      expect(
        editMinecraftProperties(
          result.content,
          { difficulty: 'hard', gamemode: 'adventure' },
          {
            release,
            supportedKeys: ['difficulty', 'gamemode', 'motd'],
          },
        ).content,
      ).toBe(result.content);
    }
  });
  it.each(['\r', '\n', '\r\n'])(
    'recognizes Java line endings %j before launcher redirects',
    (ending) => {
      expect(parseMinecraftProperties(`#generated${ending}serverJar=other.jar${ending}`)).toEqual({
        serverJar: 'other.jar',
      });
      expect(parseMinecraftProperties(`serverJar=other\\${ending}\t \f.jar${ending}`)).toEqual({
        serverJar: 'other.jar',
      });
    },
  );
  it('uses Java whitespace rather than treating Unicode whitespace as syntax', () => {
    expect(
      parseMinecraftProperties(
        ' \t\fserverJar \t\f: \t\fother.jar\n\u00a0serverJar=literal\nvalue=\u00a0keep\n',
      ),
    ).toEqual({
      serverJar: 'other.jar',
      '\u00a0serverJar': 'literal',
      value: '\u00a0keep',
    });
  });
  it('preserves unrelated values/comments and uses verified version-specific supported keys', () => {
    const input = '# custom\nmotd=Old\nserver-port=25565\nprivate-custom=value\n';
    const plan = editMinecraftProperties(
      input,
      { motd: 'A = friendly server', pvp: false },
      { release: '26.1', supportedKeys: ['motd', 'pvp'] },
    );
    expect(parseMinecraftProperties(plan.content)).toMatchObject({
      motd: 'A = friendly server',
      pvp: 'false',
      'server-port': '25565',
      'private-custom': 'value',
    });
    expect(plan.content).toContain('# custom');
    expect(plan.beforeSha256).not.toBe(plan.afterSha256);
    expect(plan.requiresStoppedServer).toBe(true);
    expect(() =>
      editMinecraftProperties(
        input,
        { 'simulation-distance': 8 },
        { release: '1.16.5', supportedKeys: ['motd'] },
      ),
    ).toThrow();
  });
  it('handles Java property escapes and continuation, rejects duplicate escaped keys', () => {
    expect(parseMinecraftProperties('motd=hello\\\n  world\nx\\:y : value\\=42\n')).toEqual({
      motd: 'helloworld',
      'x:y': 'value=42',
    });
    expect(() => parseMinecraftProperties('motd=one\nmot\\u0064=two')).toThrow();
    expect(() => parseMinecraftProperties('motd=bad\\u0xx0')).toThrow();
  });
  it('stores multiline MOTDs as one escaped property without changing protected settings', () => {
    const motd = '§aCittà 雪 😀\\folder\nserver-ip=0.0.0.0';
    const input = '#keep\nmotd=Before\nserver-ip=127.0.0.1\nonline-mode=true\n';
    const context = { release: '26.1', supportedKeys: ['motd'] };
    const result = editMinecraftProperties(input, { motd }, context);
    expect(result.content.split('\n')).toHaveLength(input.split('\n').length);
    expect(result.content).toContain('\\nserver-ip\\=0.0.0.0');
    expect(parseMinecraftProperties(result.content)).toEqual({
      motd,
      'server-ip': '127.0.0.1',
      'online-mode': 'true',
    });
    expect(editMinecraftProperties(result.content, { motd }, context).content).toBe(result.content);
    const literalEscape = '§bLiteral \\n and \\u000a';
    expect(
      parseMinecraftProperties(
        editMinecraftProperties(input, { motd: literalEscape }, context).content,
      ).motd,
    ).toBe(literalEscape);
  });
  it('keeps the 256-character MOTD limit and rejects controls other than LF', () => {
    const context = { release: '26.1', supportedKeys: ['motd'] };
    expect(() =>
      editMinecraftProperties('motd=Before\n', { motd: 'a'.repeat(256) }, context),
    ).not.toThrow();
    for (const motd of [
      'a'.repeat(257),
      ...['\r', '\0', '\t', '\b', '\f', '\x7f'].map((control) => `first${control}second`),
    ])
      expect(() => editMinecraftProperties('motd=Before\n', { motd }, context)).toThrow();
  });
  it('rejects exposure settings and invalid ranges even if declared supported', () => {
    for (const changes of [
      { 'server-ip': '0.0.0.0' },
      { 'online-mode': false },
      { 'rcon.password': 'bad' },
      { 'view-distance': 33 },
    ] as Record<string, string | number | boolean>[])
      expect(() =>
        editMinecraftProperties('', changes, {
          release: '26.1',
          supportedKeys: Object.keys(changes),
        }),
      ).toThrow();
  });
});
describe('Minecraft identity and player mutation plans', () => {
  it('requires matching independent name and UUID responses', async () => {
    const verified = await verifyMinecraftPlayer(
      'example_1',
      {
        lookupName: async () => ({ id: uuid.replaceAll('-', ''), name: 'Example_1' }),
        lookupUuid: async () => ({ id: uuid, name: 'Example_1' }),
      },
      new Date(player.verifiedAt),
    );
    expect(verified).toEqual(player);
    await expect(
      verifyMinecraftPlayer('Example_1', {
        lookupName: async () => ({ id: uuid, name: 'Example_1' }),
        lookupUuid: async () => ({ id: uuid, name: 'SomeoneElse' }),
      }),
    ).rejects.toThrow();
    expect(minecraftAvatarUrl(verified, false)).toBeUndefined();
    expect(minecraftAvatarUrl(verified, true)).toContain(uuid);
    expect(() => minecraftUuid('00000000-0000-0000-0000-000000000000')).toThrow();
  });
  const identityResponse = (
    source: 'mojang' | 'mc-api.io' = 'mojang',
    name = 'Example_1',
    id = uuid,
  ) => new Response(JSON.stringify({ [source === 'mojang' ? 'id' : 'uuid']: id, name }));
  const onlyOfficial =
    (fetcher: typeof fetch): typeof fetch =>
    async (url, init) =>
      String(url).startsWith('https://mc-api.io/')
        ? new Response(null, { status: 404 })
        : fetcher(url, init);
  it('pins provider origins, forbids redirects and still verifies both lookup directions', async () => {
    const calls: string[] = [];
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: onlyOfficial(async (url, init) => {
        calls.push(String(url));
        expect(init?.redirect).toBe('error');
        expect(init?.credentials).toBe('omit');
        return identityResponse();
      }),
    });
    expect(await verifyMinecraftPlayer('Example_1', provider)).toMatchObject({
      uuid,
      source: 'mojang',
    });
    expect(calls).toEqual([
      'https://api.mojang.com/users/profiles/minecraft/Example_1',
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replaceAll('-', '')}`,
    ]);
    expect(() => provider.lookupName('bad/name')).toThrow();
    expect(() => provider.lookupUuid('bad/uuid')).toThrow();
    const excessive = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async () => new Response('x'.repeat(65_537)),
    });
    await expect(excessive.lookupName('Example_1')).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  });
  it('retains the official alternate endpoint and independent reverse lookup', async () => {
    const calls: string[] = [];
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: onlyOfficial(async (url) => {
        calls.push(String(url));
        if (String(url).startsWith('https://api.mojang.com/'))
          throw new TypeError('Network failure');
        return identityResponse();
      }),
    });
    expect(await verifyMinecraftPlayer('Example_1', provider)).toMatchObject({
      uuid,
      source: 'mojang',
    });
    expect(calls).toEqual([
      'https://api.mojang.com/users/profiles/minecraft/Example_1',
      'https://api.minecraftservices.com/minecraft/profile/lookup/name/Example_1',
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replaceAll('-', '')}`,
    ]);
  });
  it.each([204, 404])(
    'reports not_found only when both providers report no profile (HTTP %i)',
    async (status) => {
      const fetcher = vi.fn(async () => new Response(null, { status }));
      const provider = createMinecraftIdentityProvider({
        userAgent: 'NickHosting-Test',
        fetch: fetcher,
      });
      await expect(provider.lookupName('Example_1')).rejects.toMatchObject({
        code: 'not_found',
        status: 404,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it.each([429, 500, 503])(
    'retries transient official HTTP %i without letting a mirror404 mask success',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockImplementationOnce(async () => identityResponse());
      const provider = createMinecraftIdentityProvider({
        userAgent: 'NickHosting-Test',
        fetch: onlyOfficial(fetcher),
      });
      expect(await provider.lookupName('Example_1')).toEqual({
        id: uuid,
        name: 'Example_1',
        source: 'mojang',
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('reports unavailable when one provider cannot respond and the other says not_found', async () => {
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: onlyOfficial(async () => new Response(null, { status: 503 })),
    });
    await expect(provider.lookupName('Example_1')).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  });
  it('rejects malformed successful upstream identity without retrying it', async () => {
    const fetcher = vi.fn(async () => identityResponse('mojang', 'Example_1', 'invalid'));
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: onlyOfficial(fetcher),
    });
    await expect(provider.lookupName('Example_1')).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reserves time for official fallback when the primary never responds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() => new Promise<Response>(() => {}))
        .mockImplementationOnce(async () => identityResponse());
      const provider = createMinecraftIdentityProvider({
        userAgent: 'NickHosting-Test',
        fetch: onlyOfficial(fetcher),
        timeoutMs: 100,
      });
      const result = provider.lookupName('Example_1');
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toEqual({ id: uuid, name: 'Example_1', source: 'mojang' });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds both providers and the official retry to one lookup budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
      const provider = createMinecraftIdentityProvider({
        userAgent: 'NickHosting-Test',
        fetch: fetcher,
        timeoutMs: 100,
      });
      const result = expect(provider.lookupName('Example_1')).rejects.toMatchObject({
        code: 'integration_unavailable',
      });
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds stalled response bodies and cancels all streams', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const cancel = vi.fn();
      const provider = createMinecraftIdentityProvider({
        userAgent: 'NickHosting-Test',
        timeoutMs: 100,
        fetch: async () => new Response(new ReadableStream({ cancel })),
      });
      const result = expect(provider.lookupUuid(uuid)).rejects.toMatchObject({
        code: 'integration_unavailable',
      });
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(cancel).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses the correct official reverse fallback URL', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Network failure'))
      .mockImplementationOnce(async () => identityResponse());
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: onlyOfficial(fetcher),
    });
    expect(await provider.lookupUuid(uuid)).toMatchObject({ id: uuid, source: 'mojang' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replaceAll('-', '')}`,
      `https://api.minecraftservices.com/minecraft/profile/lookup/${uuid.replaceAll('-', '')}`,
    ]);
  });
  it('takes a fast valid mc-api result, aborts the official loser and prevents its fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        String(url).startsWith('https://mc-api.io/')
          ? identityResponse('mc-api.io')
          : new Promise<Response>(() => {}),
      );
      const provider = createMinecraftIdentityProvider({
        userAgent: 'NickHosting-Test',
        fetch: fetcher,
        timeoutMs: 100,
      });
      expect(await provider.lookupName('example_1')).toEqual({
        id: uuid,
        name: 'Example_1',
        source: 'mc-api.io',
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetcher.mock.calls[1]?.[0]).toBe('https://mc-api.io/profile/example_1/JAVA');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('cancels a late loser response without starting an official fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const late = Promise.withResolvers<Response>();
      const cancel = vi.fn();
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        String(url).startsWith('https://mc-api.io/') ? identityResponse('mc-api.io') : late.promise,
      );
      const provider = createMinecraftIdentityProvider({
        userAgent: 'NickHosting-Test',
        fetch: fetcher,
        timeoutMs: 100,
      });
      expect(await provider.lookupName('Example_1')).toMatchObject({ source: 'mc-api.io' });
      late.resolve(new Response(new ReadableStream({ cancel })));
      await vi.advanceTimersByTimeAsync(200);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('takes a fast official result and cancels a stalled mirror body', async () => {
    const cancel = vi.fn();
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url) =>
        String(url).startsWith('https://mc-api.io/')
          ? new Response(new ReadableStream({ cancel }))
          : identityResponse(),
    });
    expect(await provider.lookupUuid(uuid)).toMatchObject({ source: 'mojang' });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not let a fast provider error mask the other provider success', async () => {
    const release = Promise.withResolvers<Response>();
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url) =>
        String(url).startsWith('https://mc-api.io/')
          ? new Response(null, { status: 404 })
          : release.promise,
    });
    const result = provider.lookupName('Example_1');
    await Promise.resolve();
    release.resolve(identityResponse());
    expect(await result).toMatchObject({ source: 'mojang' });
  });
  it.each(['name', 'uuid'] as const)('does not let a fast wrong %s identity win', async (kind) => {
    const release = Promise.withResolvers<Response>();
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url) =>
        String(url).startsWith('https://mc-api.io/')
          ? identityResponse(
              'mc-api.io',
              kind === 'name' ? 'WrongName' : 'Example_1',
              kind === 'uuid' ? 'abcdefab-cdef-4abc-8abc-abcdefabcdef' : uuid,
            )
          : release.promise,
    });
    const result = kind === 'name' ? provider.lookupName('Example_1') : provider.lookupUuid(uuid);
    await Promise.resolve();
    release.resolve(identityResponse());
    expect(await result).toMatchObject({ source: 'mojang' });
  });
  it.each([
    { error: true },
    { xuid: '1234567890123456' },
    { edition: 'BEDROCK' },
    { edition: 'unknown' },
  ])('rejects mc-api errors and non-Java profiles: %j', async (extra) => {
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url) =>
        String(url).startsWith('https://mc-api.io/')
          ? new Response(JSON.stringify({ uuid, name: 'Example_1', ...extra }))
          : new Response(null, { status: 404 }),
    });
    await expect(provider.lookupName('Example_1')).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  });
  it('records mc-api provenance only after independent Java name and UUID queries agree', async () => {
    const urls: string[] = [];
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url) => {
        if (!String(url).startsWith('https://mc-api.io/'))
          return new Response(null, { status: 404 });
        urls.push(String(url));
        return identityResponse('mc-api.io');
      },
    });
    expect(await verifyMinecraftPlayer('Example_1', provider)).toMatchObject({
      uuid,
      source: 'mc-api.io',
    });
    expect(urls).toEqual([
      'https://mc-api.io/profile/Example_1/JAVA',
      `https://mc-api.io/profile/${uuid}`,
    ]);
  });
  it('records mixed provenance rather than claiming official verification for both directions', async () => {
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url) => {
        const value = String(url);
        if (value.startsWith('https://api.mojang.com/')) return identityResponse();
        if (value === `https://mc-api.io/profile/${uuid}`) return identityResponse('mc-api.io');
        return new Response(null, { status: 404 });
      },
    });
    expect(await verifyMinecraftPlayer('Example_1', provider)).toMatchObject({
      uuid,
      source: 'mixed',
    });
  });
  it('still rejects cross-direction disagreement even when both primary endpoints fail', async () => {
    const provider = createMinecraftIdentityProvider({
      userAgent: 'NickHosting-Test',
      fetch: async (url) => {
        const value = String(url);
        if (value.endsWith('/JAVA')) return identityResponse('mc-api.io');
        if (value.startsWith('https://mc-api.io/'))
          return identityResponse('mc-api.io', 'OtherName');
        return new Response(null, { status: 404 });
      },
    });
    await expect(verifyMinecraftPlayer('Example_1', provider)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it.each(['mojang', 'mc-api.io', 'mixed', 'server-file'] as const)(
    'accepts verified player-list provenance %s',
    (source) => {
      expect(
        JSON.parse(
          planMinecraftPlayerList('[]', 'whitelist', 'add', { ...player, source }).content,
        ),
      ).toEqual([{ uuid, name: 'Example_1' }]);
    },
  );
  it('plans idempotent whitelist and operator changes without shell/console interpolation', () => {
    const first = planMinecraftPlayerList('[]', 'whitelist', 'add', player);
    expect(planMinecraftPlayerList(first.content, 'whitelist', 'add', player).content).toBe(
      first.content,
    );
    expect(
      JSON.parse(planMinecraftPlayerList(first.content, 'whitelist', 'remove', player).content),
    ).toEqual([]);
    const op = planMinecraftPlayerList('[]', 'operators', 'add', player, { operatorLevel: 2 });
    expect(JSON.parse(op.content)[0]).toMatchObject({ uuid, level: 2, bypassesPlayerLimit: false });
    expect(() =>
      planMinecraftPlayerList(op.content, 'operators', 'add', player, { operatorLevel: 5 }),
    ).toThrow();
    expect(() =>
      planMinecraftPlayerList('[{"uuid":"bad","name":"Example_1"}]', 'whitelist', 'remove', player),
    ).toThrow();
  });
});
const world = [
  { path: 'source/level.dat', size: 100, compressedSize: 100, type: 'file' as const },
  { path: 'source/region/r.0.0.mca', size: 1000, compressedSize: 100, type: 'file' as const },
];
describe('Minecraft isolated world plans', () => {
  it('maps one world root without rewriting version-specific dimension layouts', () => {
    const plan = planMinecraftWorldImport(
      [
        ...world,
        {
          path: 'source/dimensions/minecraft/the_nether/region/r.0.0.mca',
          size: 100,
          compressedSize: 50,
          type: 'file',
        },
      ],
      { targetWorld: 'survival', maxBytes: 10_000 },
    );
    expect(plan.files[2]?.target).toBe('survival/dimensions/minecraft/the_nether/region/r.0.0.mca');
    expect(plan.requiresNbtValidation).toBe(true);
    expect(plan.totalBytes).toBe(1200);
  });
  it.each(['source/', 'Map package/DIVERSITY 3 v1.6.6 - for 1.14.4/'])(
    'selects only the unique world root %s and ignores package companions',
    (root) => {
      const plan = planMinecraftWorldImport(
        [
          ...world.map((entry) => ({ ...entry, path: `${root}${entry.path.slice(7)}` })),
          { path: 'cover.png', size: 250, compressedSize: 250, type: 'file' },
          { path: 'Map package/Instructions.txt', size: 50, compressedSize: 50, type: 'file' },
          {
            path: `${root.slice(0, -1)}-extras/readme.txt`,
            size: 25,
            compressedSize: 25,
            type: 'file',
          },
          { path: 'tools/install.sh', size: 10, compressedSize: 10, type: 'file' },
        ],
        { targetWorld: 'survival', maxBytes: 10_000 },
      );
      expect(plan.sourceRoot).toBe(root);
      expect(plan.files).toEqual([
        { source: `${root}level.dat`, target: 'survival/level.dat', size: 100 },
        { source: `${root}region/r.0.0.mca`, target: 'survival/region/r.0.0.mca', size: 1000 },
      ]);
      expect(plan.totalBytes).toBe(1100);
    },
  );
  it('preserves a world stored directly at the archive root', () => {
    const plan = planMinecraftWorldImport(
      world.map((entry) => ({ ...entry, path: entry.path.slice('source/'.length) })),
      { targetWorld: 'survival', maxBytes: 10_000 },
    );
    expect(plan.sourceRoot).toBe('');
    expect(plan.files).toEqual([
      { source: 'level.dat', target: 'survival/level.dat', size: 100 },
      { source: 'region/r.0.0.mca', target: 'survival/region/r.0.0.mca', size: 1000 },
    ]);
    expect(plan.totalBytes).toBe(1100);
  });
  it('still validates skipped package entries before selecting the world', () => {
    for (const addition of [
      { path: '../outside.txt', size: 1, compressedSize: 1, type: 'file' as const },
      { path: 'outside/link', size: 1, compressedSize: 1, type: 'symlink' as const },
      { path: 'outside/bomb.png', size: 1000, compressedSize: 1, type: 'file' as const },
      { path: 'outside/large.png', size: 10000, compressedSize: 10000, type: 'file' as const },
    ])
      expect(() =>
        planMinecraftWorldImport([...world, addition], { targetWorld: 'safe', maxBytes: 10000 }),
      ).toThrow();
    const companion = { path: 'cover.png', size: 1, compressedSize: 1, type: 'file' as const };
    expect(() =>
      planMinecraftWorldImport([...world, companion, { ...companion, path: 'COVER.PNG' }], {
        targetWorld: 'safe',
        maxBytes: 10000,
      }),
    ).toThrow();
    expect(() =>
      planMinecraftWorldImport([...world, companion, { ...companion, path: 'cover.png/child' }], {
        targetWorld: 'safe',
        maxBytes: 10000,
      }),
    ).toThrow();
    expect(() =>
      planMinecraftWorldImport([...world, companion], {
        targetWorld: 'safe',
        maxBytes: 10000,
        maxEntries: 2,
      }),
    ).toThrow();
  });
  it.each([
    '../other/level.dat',
    '/level.dat',
    'C:/level.dat',
    'source/../level.dat',
    'source\\level.dat',
    'source/mod.jar',
    'source/.hidden/file',
  ])('rejects unsafe world path %s', (path) => {
    expect(() =>
      planMinecraftWorldImport([...world, { path, size: 1, compressedSize: 1, type: 'file' }], {
        targetWorld: 'safe',
        maxBytes: 10000,
      }),
    ).toThrow();
  });
  it('rejects case collisions, multiple worlds, symlinks, bombs and storage exhaustion', () => {
    for (const addition of [
      { path: 'source/LEVEL.DAT', size: 1, compressedSize: 1, type: 'file' as const },
      { path: 'other/level.dat', size: 1, compressedSize: 1, type: 'file' as const },
      { path: 'source/link', size: 1, compressedSize: 1, type: 'symlink' as const },
      { path: 'source/bomb', size: 1000, compressedSize: 1, type: 'file' as const },
    ])
      expect(() =>
        planMinecraftWorldImport([...world, addition], { targetWorld: 'safe', maxBytes: 10000 }),
      ).toThrow();
    expect(() => planMinecraftWorldImport(world, { targetWorld: 'safe', maxBytes: 100 })).toThrow();
    expect(() =>
      planMinecraftWorldImport(world, { targetWorld: 'plugins', maxBytes: 10000 }),
    ).toThrow();
  });
  it('selects only verified compatible world DataVersion and preserves config', () => {
    const plan = planMinecraftWorldSelection(
      'motd=Hi\nlevel-name=old\n',
      { name: 'survival', verifiedDataVersion: 5000, sha256: 'a'.repeat(64) },
      { allowedDataVersions: [5000] },
    );
    expect(parseMinecraftProperties(plan.content)).toEqual({
      motd: 'Hi',
      'level-name': 'survival',
    });
    expect(() =>
      planMinecraftWorldSelection(
        '',
        { name: 'survival', verifiedDataVersion: 5001, sha256: 'a'.repeat(64) },
        { allowedDataVersions: [5000] },
      ),
    ).toThrow();
  });
});
describe('Minecraft four-step public wizard', () => {
  const choices = [
    {
      id: 'choice1',
      release: '26.1',
      runtime: 'fabric' as const,
      nameKey: 'games.minecraft.runtime.fabric',
      protocol: 9999,
      status: 'verified',
    },
  ];
  const pack = {
    provider: 'modrinth' as const,
    projectId: 'pack',
    versionId: 'version',
    release: '26.1',
    runtime: 'fabric' as const,
    loaderVersion: '0.19.5',
    choiceId: 'choice1',
  };
  it('uses four steps, derives pack runtime/version and retains player settings without technical badges', () => {
    const descriptor = minecraftWizard(choices, pack);
    expect(descriptor.steps.map((step) => step.id)).toEqual([
      'choose-game',
      'configure',
      'resources',
      'create',
    ]);
    const fields = descriptor.steps[1]?.fields.map((field) => field.id);
    expect(fields).toContain('operators');
    expect(fields).toContain('whitelist');
    expect(fields).not.toContain('runtimeVersion');
    expect(JSON.stringify(descriptor)).not.toContain('protocol');
    expect(JSON.stringify(descriptor)).not.toContain('verified');
    expect(minecraftWizard(choices).steps[1]?.fields.map((field) => field.id)).toContain(
      'runtimeVersion',
    );
  });
  it('cannot use an unavailable choice or silently retarget an existing immutable runtime', () => {
    expect(() => minecraftWizard([], pack)).toThrow();
    expect(() =>
      assertModpackRuntimeCompatible(
        { release: '26.1', runtime: 'fabric', loaderVersion: '0.19.5' },
        pack,
      ),
    ).not.toThrow();
    expect(() =>
      assertModpackRuntimeCompatible({ release: '26.1', runtime: 'paper' }, pack),
    ).toThrow();
    expect(() =>
      assertModpackRuntimeCompatible(
        { release: '26.1', runtime: 'fabric', loaderVersion: '0.19.4' },
        pack,
      ),
    ).toThrow();
  });
});
