import { describe, expect, it } from 'vitest';
import { mapSearchCoordinates } from './map-players.js';

describe('map search destinations', () => {
  it.each(['12.5, 40', '12.5;40', ' 12.5  40 '])('reads both axes from %s', (query) => {
    expect(mapSearchCoordinates(query)).toEqual({ x: 12.5, z: 40 });
  });

  it('distinguishes names, numeric names and incomplete input from destinations', () => {
    for (const query of ['Player 42', '123', '12,', '12; player', '12, 40, 60', '']) {
      expect(mapSearchCoordinates(query)).toBeNull();
    }
    expect(mapSearchCoordinates(`${'9'.repeat(400)}, 0`)).toBeNull();
    expect(mapSearchCoordinates('0,0')).toEqual({ x: 0, z: 0 });
  });
});
