import { type ContentHttp, unavailable } from './contracts.js';
import type { CurseForgeProvider } from './curseforge.js';
import { type ModpackProvider, modpackProviderSchema } from './modpack-catalog.js';
import { AtLauncherModpackCatalog } from './modpack-catalog-atlauncher.js';
import { CurseForgeModpackCatalog } from './modpack-catalog-curseforge.js';
import { FtbModpackCatalog } from './modpack-catalog-ftb.js';
import { ModrinthModpackCatalog } from './modpack-catalog-modrinth.js';
import { TechnicModpackCatalog } from './modpack-catalog-technic.js';
import { VoidsWrathModpackCatalog } from './modpack-catalog-voidswrath.js';
import type { ModpackCatalog } from './modpack-recipes.js';

// Transport identity already includes effective origins/settings. Credential-bound
// catalogs additionally use the exact CF instance, so rotation cannot reuse it.
const catalogs = new WeakMap<
  ContentHttp,
  {
    public: Map<Exclude<ModpackProvider, 'curseforge'>, ModpackCatalog>;
    curseforge: WeakMap<CurseForgeProvider, ModpackCatalog>;
  }
>();

export function createModpackCatalog(
  provider: ModpackProvider,
  options: {
    http: ContentHttp;
    curseforge?: CurseForgeProvider;
  },
): ModpackCatalog {
  const selected = modpackProviderSchema.parse(provider);
  let cached = catalogs.get(options.http);
  if (!cached) {
    cached = { public: new Map(), curseforge: new WeakMap() };
    catalogs.set(options.http, cached);
  }
  if (selected === 'curseforge') {
    if (!options.curseforge) unavailable('curseforge_credentials');
    let value = cached.curseforge.get(options.curseforge);
    if (!value) {
      value = new CurseForgeModpackCatalog(options.curseforge);
      cached.curseforge.set(options.curseforge, value);
    }
    return value;
  }
  const existing = cached.public.get(selected);
  if (existing) return existing;
  const create = (): ModpackCatalog => {
    switch (selected) {
      case 'modrinth':
        return new ModrinthModpackCatalog(options.http);
      case 'ftb':
        return new FtbModpackCatalog(options.http);
      case 'technic':
        return new TechnicModpackCatalog(options.http);
      case 'voidswrath':
        return new VoidsWrathModpackCatalog(options.http);
      case 'atlauncher':
        return new AtLauncherModpackCatalog(options.http);
    }
  };
  const value = create();
  cached.public.set(selected, value);
  return value;
}
