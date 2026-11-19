import { describe, expect, it } from 'vitest';
import { networkRates, parseConsoleResources, rollingTelemetry } from './console-resources.js';

describe('console resource snapshots', () => {
  it('leaves absent network and uptime unavailable while retaining provider cached disk', () => {
    expect(parseConsoleResources({ memory_bytes: 1024, cpu_absolute: 5, disk_bytes: 999 })).toEqual(
      {
        memory_bytes: 1024,
        cpu_absolute: 5,
        disk_bytes: 999,
        uptime: undefined,
        network_rx_bytes: undefined,
        network_tx_bytes: undefined,
      },
    );
  });
  it('rejects malformed, negative and nonfinite measurements', () => {
    for (const value of [
      null,
      {},
      { memory_bytes: -1, cpu_absolute: 5 },
      { memory_bytes: 1, cpu_absolute: Infinity },
      { memory_bytes: 1, cpu_absolute: 1, network: { rx_bytes: 1 } },
    ]) {
      expect(parseConsoleResources(value)).toBeUndefined();
    }
  });
  it('keeps valid zero counters distinct from missing measurements', () => {
    expect(
      parseConsoleResources({
        memory_bytes: 0,
        cpu_absolute: 0,
        uptime: 0,
        network: { rx_bytes: 0, tx_bytes: 0 },
      }),
    ).toMatchObject({ uptime: 0, network_rx_bytes: 0, network_tx_bytes: 0 });
  });
});

describe('rolling telemetry window', () => {
  it('retains only the latest actual observation in each second of the last 30 seconds', () => {
    const sample = (time: number) => ({ time, cpu: time, memory: 1, rx: 2, tx: 3 });
    expect(
      rollingTelemetry(
        [sample(1), sample(30000), sample(30900), sample(32000), sample(62000)],
        61000,
      ),
    ).toEqual([sample(32000)]);
    expect(rollingTelemetry([sample(31000), sample(31900), sample(32000)], 61000)).toEqual([
      sample(31900),
      sample(32000),
    ]);
  });
  it('preserves a missing observation as a gap instead of a zero or invented sample', () => {
    const missing = { time: 1000, cpu: NaN, memory: NaN, rx: NaN, tx: NaN };
    expect(rollingTelemetry([missing], 5000)).toEqual([missing]);
    expect(rollingTelemetry([missing], 32000)).toEqual([]);
  });
});

it('plots independent rates over elapsed time and skips counter resets and gaps', () => {
  const samples = [
    { time: 1000, rx: 100, tx: 50 },
    { time: 2500, rx: 106, tx: 50 },
    { time: 3500, rx: 0, tx: 53 },
    { time: 7500, rx: 10, tx: 60 },
  ].map((sample) => ({ ...sample, cpu: 0, memory: 0 }));
  expect(networkRates(samples, 'rx').map((point) => point.value)).toEqual([NaN, 4, NaN, NaN]);
  expect(networkRates(samples, 'tx').map((point) => point.value)).toEqual([NaN, 0, 3, NaN]);
});
