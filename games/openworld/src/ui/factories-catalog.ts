const messages: Record<string, [string, string]> = {
  title: ['Factories', 'Fabbriche'],
  simulation: ['Factory simulation', 'Simulazione delle fabbriche'],
  paused: ['Paused', 'In pausa'],
  world: ['All factories', 'Tutte le fabbriche'],
  loaded: ['Loaded areas only', 'Solo aree caricate'],
  offline: ['Start the server to see its factories.', 'Avvia il server per vedere le fabbriche.'],
  disabled: [
    'Factory simulation is disabled on this server.',
    'La simulazione delle fabbriche è disabilitata su questo server.',
  ],
  waiting: ['Waiting for factory measurements.', 'In attesa delle misurazioni sulle fabbriche.'],
  empty: ['The simulation has no factory nodes.', 'La simulazione non contiene nodi di fabbrica.'],
  frequency: ['Measured frequency', 'Frequenza misurata'],
  target: ['Target frequency', 'Frequenza impostata'],
  p95: ['Step duration (p95)', 'Durata del passo (p95)'],
  nodes: ['Nodes', 'Nodi'],
  nets: ['Networks', 'Reti'],
  pieces: ['Parts', 'Componenti'],
  power: ['Power and batteries', 'Energia e batterie'],
  produced: ['Power generated', 'Potenza generata'],
  used: ['Power consumed', 'Potenza consumata'],
  stored: ['Stored energy', 'Energia accumulata'],
  capacity: ['Battery capacity', 'Capacità delle batterie'],
  transit: ['In transit', 'In transito'],
  items: ['Items', 'Oggetti'],
  fluids: ['Fluid voxels', 'Voxel di fluido'],
  columns: ['Highest-cost columns', 'Colonne più costose'],
  noColumns: [
    'No columns registered a processing cost.',
    'Nessuna colonna ha registrato un costo di elaborazione.',
  ],
  coords: ['Face {face} · {i}, {j}', 'Faccia {face} · {i}, {j}'],
  position: ['Face {face} · {x}, {z} m', 'Faccia {face} · {x}, {z} m'],
  cost: ['Processing time', 'Tempo di calcolo'],
  share: ['Share', 'Quota'],
  map: ['Open on map', 'Apri sulla mappa'],
  missing: ['Not reported', 'Non disponibile'],
};
const catalog = (locale: 0 | 1) =>
  Object.fromEntries(
    Object.entries(messages).map(([key, pair]) => [
      `games.openworld.factories.${key}`,
      pair[locale],
    ]),
  );
export const openworldFactoriesCatalogs = { en: catalog(0), it: catalog(1) };
