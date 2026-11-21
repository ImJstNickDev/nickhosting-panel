const messages: Record<string, [string, string]> = {
  view: ['Map view', 'Vista della mappa'],
  terrain: ['Terrain', 'Terreno'],
  creatures: ['Creatures', 'Creature'],
  space: ['Space', 'Spazio'],
  population: ['Active population in {world}', 'Popolazione attiva su {world}'],
  groundItems: ['Items on the ground', 'Oggetti a terra'],
  species: ['Species', 'Specie'],
  count: ['Count', 'Numero'],
  markers: ['Show creature positions', 'Mostra posizioni delle creature'],
  creatureMarker: ['Creature · {name}', 'Creatura · {name}'],
  unknownSpecies: ['Species {id}', 'Specie {id}'],
  partialMarkers: [
    'The map shows a sample of the creature positions.',
    'La mappa mostra un campione delle posizioni delle creature.',
  ],
  noSpecies: ['No species recorded in this world.', 'Nessuna specie registrata in questo mondo.'],
  body: ['Celestial body', 'Corpo celeste'],
  orbitalMap: ['Orbital view centered on {body}', 'Vista orbitale centrata su {body}'],
  noBodies: ['No celestial bodies available.', 'Nessun corpo celeste disponibile.'],
  centerBody: ['Center on {name}', 'Centra su {name}'],
  parent: ['Orbits', 'In orbita attorno a'],
  radius: ['Radius', 'Raggio'],
  separation: ['Distance from {name}', 'Distanza da {name}'],
  openTerrain: ['Open terrain map', 'Apri mappa del terreno'],
  travelers: ['Players in space', 'Giocatori nello spazio'],
  noTravelers: ['No players in space.', 'Nessun giocatore nello spazio.'],
  noPins: ['No checkpoints in this view.', 'Nessun checkpoint in questa vista.'],
  orbitScale: ['Top view · X/Z plane', 'Vista dall’alto · piano X/Z'],
  markerLegend: ['Creature', 'Creatura'],
};
const catalog = (index: 0 | 1) =>
  Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      `games.openworld.map.layers.${key}`,
      value[index],
    ]),
  );
export const openworldMapLayerCatalogs = { en: catalog(0), it: catalog(1) };
