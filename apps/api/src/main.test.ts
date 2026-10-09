import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ close: vi.fn(async () => {}), log: vi.fn() }));
vi.mock('./runtime.js', () => ({
  createRuntime: async () => ({
    app: { fetch: () => new Response('fixture') },
    close: fixture.close,
    logger: { log: fixture.log },
  }),
}));

import { main } from './main.js';

describe('API executable lifecycle', () => {
  it('rejects a real bind collision and closes resources without reporting startup', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, 'localhost', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    try {
      await expect(
        main({ NH_API_BIND_HOST: 'localhost', NH_API_PORT: String(address.port) }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(fixture.close).toHaveBeenCalledOnce();
      expect(fixture.log).not.toHaveBeenCalledWith('info', 'api.started');
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  it('rejects missing listener configuration before opening resources', async () => {
    await expect(main({})).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(main({ NH_API_BIND_HOST: 'localhost', NH_API_PORT: 'bad' })).rejects.toMatchObject(
      { code: 'configuration_invalid' },
    );
  });
});
