import type { ModpackProvider } from '../../../../../packages/content-providers/src/modpack-catalog.js';
import { modpackProviders } from './modpacks-model.js';

const logos: Record<ModpackProvider, string> = {
  modrinth: new URL('./provider-logos/modrinth.png', import.meta.url).href,
  curseforge: new URL('./provider-logos/curseforge.ico', import.meta.url).href,
  ftb: new URL('./provider-logos/ftb.png', import.meta.url).href,
  technic: new URL('./provider-logos/technic.ico', import.meta.url).href,
  voidswrath: new URL('./provider-logos/voidswrath.png', import.meta.url).href,
  atlauncher: new URL('./provider-logos/atlauncher.svg', import.meta.url).href,
};

export function ModpackProviderLabel({ provider }: { provider: ModpackProvider }) {
  return (
    <span className="modpacks-provider-label">
      <img src={logos[provider]} alt="" width={20} height={20} />
      <span>{modpackProviders[provider]}</span>
    </span>
  );
}
