const messages: Record<string, [string, string]> = {
  title: ['Seed Inspector', 'Seed Inspector'],
  seed: ['World seed', 'Seed del mondo'],
  original: ['Seed text', 'Testo del seed'],
  faceSize: ['Face size', 'Lato della faccia'],
  radius: ['Planet radius', 'Raggio del pianeta'],
  voxel: ['Voxel size', 'Lato del voxel'],
  spawn: ['Spawn point', 'Punto di spawn'],
  position: ['Face {face} · X {x} · Z {z}', 'Faccia {face} · X {x} · Z {z}'],
  open: ['Open native inspector', 'Apri l’Inspector del gioco'],
  restricted: [
    'The native viewer requires a direct server grant and a regular panel session.',
    'Il visualizzatore del gioco richiede un permesso diretto sul server e una sessione ordinaria del pannello.',
  ],
  unpublished: [
    'The native terrain and resource viewer is available when the web dashboard is published.',
    'Il visualizzatore di terreno e risorse del gioco è disponibile quando la dashboard web è pubblicata.',
  ],
  offline: ['Start the server to inspect its seed.', 'Avvia il server per consultarne il seed.'],
  catalog: ['Generation catalog', 'Catalogo di generazione'],
  group: ['Category', 'Categoria'],
  search: ['Search catalog', 'Cerca nel catalogo'],
  planets: ['Planets', 'Pianeti'],
  biomes: ['Biomes', 'Biomi'],
  materials: ['Materials', 'Materiali'],
  featureKinds: ['Features and deposits', 'Strutture e giacimenti'],
  treeSpecies: ['Tree species', 'Specie di alberi'],
  empty: ['No matching entries.', 'Nessun risultato.'],
};
const catalog = (index: 0 | 1) =>
  Object.fromEntries(
    Object.entries(messages).map(([key, pair]) => [`games.openworld.seed.${key}`, pair[index]]),
  );
export const openworldSeedCatalogs = { en: catalog(0), it: catalog(1) };
