import type { OpenworldCreatureLayer } from '../../../../../games/openworld/src/map-layers.js';
import { useFormat, useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { mapKey as k, mapParams, useMapData } from './map-query.js';
import type { ServerView } from './telemetry.js';

export function useCreatureLayer(
  server: ServerView,
  world: string,
  processRef: string,
  enabled: boolean,
  markers: boolean,
) {
  const params = mapParams({ world, processRef, ...(markers ? { markers: 1 } : {}) });
  return useMapData<OpenworldCreatureLayer>(server, `/creatures?${params}`, enabled, 15000);
}

export function CreaturePopulation({
  query,
  worldName,
  markers,
}: {
  query: ReturnType<typeof useCreatureLayer>;
  worldName: string;
  markers: boolean;
}) {
  const t = useT(),
    format = useFormat();
  const data = query.data;
  return (
    <section className="ow-creatures">
      <div className="ow-map-side-head">
        <h3>{t(k('layers.population'), { world: worldName })}</h3>
      </div>
      {query.error ? (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <dl className="ow-map-counts">
            <div>
              <dt>{t(k('layers.creatures'))}</dt>
              <dd>{format.number(data.total)}</dd>
            </div>
            <div>
              <dt>{t(k('layers.groundItems'))}</dt>
              <dd>{format.number(data.items)}</dd>
            </div>
          </dl>
          {data.species.length ? (
            <div className="ow-species-scroll">
              <table className="ow-species">
                <thead>
                  <tr>
                    <th scope="col">{t(k('layers.species'))}</th>
                    <th scope="col">{t(k('layers.count'))}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.species.map((species) => (
                    <tr key={species.id}>
                      <th scope="row">
                        {species.name ||
                          species.key ||
                          t(k('layers.unknownSpecies'), { id: species.id })}
                      </th>
                      <td>{format.number(species.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="ow-empty">{t(k('layers.noSpecies'))}</p>
          )}
          {markers && data.markersTruncated && (
            <p className="ow-map-layer-note">{t(k('layers.partialMarkers'))}</p>
          )}
        </>
      )}
    </section>
  );
}
