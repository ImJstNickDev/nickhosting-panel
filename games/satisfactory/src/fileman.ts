import { isCertificateName, isCrashContextName } from './viewers/diagnostic-names.js';
import { satisfactorySaveDirectory } from './world-paths.js';

/** Native server settings use Unreal GVAS, not the world-save header format. */
export const isSatisfactoryServerSettings = (name: string) =>
  /^ServerSettings(?:\.\d+)?\.sav$/i.test(name);

/** Filename classification is presentation only, never proof of file contents. */
export function satisfactoryFileKind(name: string) {
  const value = name.toLowerCase();
  if (isSatisfactoryServerSettings(name)) return 'serverSettings';
  if (value.endsWith('.sav')) return 'save';
  if (value.endsWith('.sbp') || value.endsWith('.sbpcfg')) return 'blueprint';
  if (value.endsWith('.ini')) return 'configuration';
  if (value.endsWith('.log')) return 'log';
  if (isCrashContextName(name)) return 'crash';
  if (isCertificateName(name)) return 'certificate';
  if (
    value.endsWith('.uplugin') ||
    value.endsWith('.smmprofile') ||
    value === 'nick_hosting-lock.json' ||
    value === 'profiles.json'
  )
    return 'modManifest';
  return undefined;
}

/** Known installation locations. Opening one uses normal Fileman missing-path handling. */
export const satisfactoryFileLocations = [
  { id: 'saves', path: satisfactorySaveDirectory },
  { id: 'mods', path: 'FactoryGame/Mods' },
  { id: 'configuration', path: 'FactoryGame/Saved/Config' },
  { id: 'logs', path: 'FactoryGame/Saved/Logs' },
  { id: 'crashes', path: 'FactoryGame/Saved/Crashes' },
] as const;
