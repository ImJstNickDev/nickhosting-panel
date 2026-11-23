import type { OpenworldFactoriesSnapshot } from '../../../../../games/openworld/src/factories.js';
import { useT } from '../../app/i18n.js';
import { FactoryPanel, FactoryQuantities, factoryKey } from './factory-breakdowns.js';
import { Metrics, numeric, useMetricsFormat } from './telemetry.js';

type Data = OpenworldFactoriesSnapshot;

export function FactoryPower({ power }: { power: NonNullable<Data['power']> }) {
  const t = useT();
  const { metric, duration } = useMetricsFormat();
  const { producedW, usedW, storedJ, capacityJ } = power;
  const wh = (joules: number | null | undefined) =>
    metric(numeric(joules) ? joules / 3600 : null, 'Wh', 2);
  const net = numeric(producedW) && numeric(usedW) ? producedW - usedW : null;
  const charge =
    numeric(storedJ) && numeric(capacityJ) && capacityJ > 0 ? 100 * (storedJ / capacityJ) : null;
  const untilFull =
    numeric(net) && net > 0 && numeric(capacityJ) && numeric(storedJ) && storedJ < capacityJ
      ? (capacityJ - storedJ) / net
      : null;
  const untilEmpty =
    numeric(net) && net < 0 && numeric(storedJ) && storedJ > 0 ? storedJ / -net : null;
  return (
    <FactoryPanel title="power">
      <Metrics
        items={[
          [t(factoryKey('produced')), metric(producedW, 'W')],
          [t(factoryKey('used')), metric(usedW, 'W')],
          [t(factoryKey('powerSystems')), metric(power.systems)],
        ]}
      />
      {numeric(net) && (
        <p className="ow-factory-balance" data-deficit={net < 0}>
          {net === 0
            ? t(factoryKey('balanced'))
            : t(factoryKey(net > 0 ? 'surplus' : 'deficit'), { power: metric(Math.abs(net), 'W') })}
        </p>
      )}
      <div className="ow-factory-battery">
        <div>
          <h4>{t(factoryKey('charge'))}</h4>
          <strong>{capacityJ === 0 ? t(factoryKey('noBattery')) : metric(charge, '%')}</strong>
        </div>
        {numeric(charge) && (
          <meter
            aria-label={t(factoryKey('charge'))}
            min={0}
            max={100}
            value={Math.min(100, charge)}
            low={10}
            high={25}
            optimum={100}
          />
        )}
        <Metrics
          items={[
            [t(factoryKey('stored')), wh(storedJ)],
            [t(factoryKey('capacity')), wh(capacityJ)],
          ]}
        />
        {numeric(untilFull) && (
          <p className="ow-factory-caption">
            {t(factoryKey('untilFull'), { time: duration(untilFull) })}
          </p>
        )}
        {numeric(untilEmpty) && (
          <p className="ow-factory-caption">
            {t(factoryKey('untilEmpty'), { time: duration(untilEmpty) })}
          </p>
        )}
      </div>
    </FactoryPanel>
  );
}

export function FactoryTransit({ transit }: { transit: NonNullable<Data['transit']> }) {
  const t = useT();
  const { metric } = useMetricsFormat();
  const rows = (transit.itemTypes ?? []).map((item, index) => ({
    id: `${index}:${item.name}`,
    label: item.name,
    value: item.count,
  }));
  return (
    <FactoryPanel title="transit">
      <Metrics
        items={[
          [t(factoryKey('items')), metric(transit.items)],
          [t(factoryKey('fluids')), metric(transit.fluidVoxels)],
        ]}
      />
      <h4 className="ow-factory-subtitle">{t(factoryKey('itemTypes'))}</h4>
      <FactoryQuantities rows={rows} empty={transit.items === 0 ? 'noItems' : 'noItemBreakdown'} />
    </FactoryPanel>
  );
}

export function FactorySystems({ data }: { data: Data }) {
  const t = useT();
  const { metric } = useMetricsFormat();
  return (
    <div className="ow-factory-systems">
      {data.rotation && (
        <FactoryPanel title="rotation">
          <Metrics
            items={[
              [t(factoryKey('rotationSystems')), metric(data.rotation.systems)],
              [t(factoryKey('jammed')), metric(data.rotation.jammed)],
              [t(factoryKey('delivered')), metric(data.rotation.deliveredW, 'W')],
            ]}
          />
        </FactoryPanel>
      )}
      {data.radio && (
        <FactoryPanel title="radio">
          <Metrics
            items={[
              [t(factoryKey('emitters')), metric(data.radio.emitters)],
              [t(factoryKey('receivers')), metric(data.radio.receivers)],
              [t(factoryKey('channels')), metric(data.radio.channels)],
            ]}
          />
        </FactoryPanel>
      )}
      {data.pumps && (
        <FactoryPanel title="pumps">
          <Metrics
            items={[
              [t(factoryKey('pumpCount')), metric(data.pumps.count)],
              [t(factoryKey('pumped')), metric(data.pumps.pumpedVoxels)],
              [t(factoryKey('pending')), metric(data.pumps.pendingTerrainVoxels)],
            ]}
          />
        </FactoryPanel>
      )}
    </div>
  );
}
