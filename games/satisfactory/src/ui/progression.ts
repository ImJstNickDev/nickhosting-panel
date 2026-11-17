import { satisfactoryMilestoneNames } from './progression-data.js';
/** Presentation only. QueryServerState reports the CURRENT phase, not the next
 * Space Elevator delivery. Phase 0 must therefore never be shifted to phase 1.
 * See docs/M6-SATISFACTORY.md for the native/SCIM mapping evidence. */
export type SatisfactoryProgressionLabel =
  | { kind: 'localized'; key: string; values?: Record<string, string | number> }
  | { kind: 'custom'; label: string };
const prefix = 'games.satisfactory.progression.';
function localized(
  key: string,
  values?: Record<string, string | number>,
): SatisfactoryProgressionLabel {
  return { kind: 'localized', key: prefix + key, ...(values ? { values } : {}) };
}
function reference(value: string): { path: string; name: string } | undefined {
  // Accept native exported object references and their unwrapped object paths.
  const quoted = value.match(/^(?:\/Script\/[\w.]+)?(['"])(\/[^'"]+)\1$/);
  const path = (quoted?.[2] ?? value).match(/^(\/[\w/-]+)\.([\w-]+)$/);
  if (!path?.[1] || !path[2]) return undefined;
  const file = path[1].split('/').at(-1);
  if (path[2] !== file && path[2] !== `${file}_C`) return undefined;
  return { path: path[1], name: path[2].replace(/_C$/, '') };
}
function fallback(value: string, asset?: { name: string }): SatisfactoryProgressionLabel {
  const text = asset?.name.replace(/^(?:GP_|Schematic_|Research_)/, '') ?? value;
  // Never spill a malformed object path or export wrapper into the interface.
  if (/[/'"\\<>]|\p{Cc}/u.test(text)) return localized('unknown');
  const label = text
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return label ? { kind: 'custom', label: label.slice(0, 160) } : localized('unknown');
}
const empty = (value: string) => value === '' || /^(?:none|null)$/i.test(value);
export function satisfactoryPhaseLabel(input: string): SatisfactoryProgressionLabel {
  const value = input.trim();
  if (empty(value)) return localized('noPhase');
  if (value.length > 4096) return localized('unknown');
  const asset = reference(value);
  const match = asset?.path.match(
    /^\/Game\/FactoryGame\/GamePhases\/GP_Project_Assembly_Phase_(\d{1,3})$/,
  );
  if (match) {
    const phase = Number(match[1]);
    return phase <= 7 ? localized(`phase.${phase}`) : localized('phaseNumber', { phase });
  }
  return fallback(value, asset);
}
export function satisfactorySchematicLabel(input: string): SatisfactoryProgressionLabel {
  const value = input.trim();
  if (empty(value)) return localized('noMilestone');
  if (value.length > 4096) return localized('unknown');
  const asset = reference(value);
  if (asset && Object.hasOwn(satisfactoryMilestoneNames, asset.name)) {
    const folder = asset.name.startsWith('Schematic_Tutorial') ? 'Tutorial' : 'Progression';
    if (asset.path === `/Game/FactoryGame/Schematics/${folder}/${asset.name}`)
      return localized(`milestone.${asset.name}`);
  }
  // A mod reusing a vanilla object name does not acquire a vanilla translation.
  if (asset && asset.path === `/Game/FactoryGame/Schematics/Progression/${asset.name}`) {
    const milestone = asset.name.match(/^Schematic_(\d{1,2}-\d{1,2}(?:-\d{1,2})?)$/);
    if (milestone) return localized('milestoneNumber', { milestone: milestone[1] ?? '' });
  }
  return fallback(value, asset);
}
