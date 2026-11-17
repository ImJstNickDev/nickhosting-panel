import { satisfactoryMilestoneNames } from './progression-data.js';

// Italian labels are NickPanel translations, not a claim to reproduce a particular
// game's localization build. Vanilla phase IDs follow the current phase semantics.
const entries: Record<string, readonly [string, string]> = {
  'phase.0': ['Phase 0 · Establishing Phase', 'Fase 0 · Insediamento'],
  'phase.1': ['Phase 1 · Distribution Platform', 'Fase 1 · Piattaforma di distribuzione'],
  'phase.2': ['Phase 2 · Construction Dock', 'Fase 2 · Bacino di costruzione'],
  'phase.3': ['Phase 3 · Main Body', 'Fase 3 · Corpo principale'],
  'phase.4': ['Phase 4 · Propulsion', 'Fase 4 · Propulsione'],
  'phase.5': ['Phase 5 · Assembly', 'Fase 5 · Assemblaggio'],
  'phase.6': ['Project Assembly launch', 'Lancio del Progetto Assemblaggio'],
  'phase.7': ['Project Assembly completed', 'Progetto Assemblaggio completato'],
  phaseNumber: ['Phase {phase}', 'Fase {phase}'],
  milestoneNumber: ['Milestone {milestone}', 'Traguardo {milestone}'],
  noPhase: ['No active phase', 'Nessuna fase attiva'],
  noMilestone: ['No milestone selected', 'Nessun traguardo selezionato'],
  unknown: ['Unknown', 'Sconosciuto'],
  ...Object.fromEntries(
    Object.entries(satisfactoryMilestoneNames).map(([name, labels]) => [
      `milestone.${name}`,
      labels,
    ]),
  ),
};
export const satisfactoryProgressionCatalogs = {
  en: Object.fromEntries(
    Object.entries(entries).map(([key, values]) => [
      `games.satisfactory.progression.${key}`,
      values[0],
    ]),
  ),
  it: Object.fromEntries(
    Object.entries(entries).map(([key, values]) => [
      `games.satisfactory.progression.${key}`,
      values[1],
    ]),
  ),
};
