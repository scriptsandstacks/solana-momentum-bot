import { describe, expect, it } from 'vitest';
import { computeVolumeAcceleration } from '../src/bot/volumeAcceleration.js';

describe('computeVolumeAcceleration', () => {
  it('returns only sample count when there is not enough history', () => {
    const result = computeVolumeAcceleration(20_000, [{ volume5mUsd: 10_000 }, { volume5mUsd: 12_000 }]);

    expect(result.volumeAccelerationSamples).toBe(2);
    expect(result.volumeAcceleration5mZ).toBeUndefined();
  });

  it('computes a positive z-score against recent baseline volume', () => {
    const result = computeVolumeAcceleration(30_000, [
      { volume5mUsd: 10_000 },
      { volume5mUsd: 11_000 },
      { volume5mUsd: 12_000 },
      { volume5mUsd: 13_000 },
    ]);

    expect(result.volumeAccelerationSamples).toBe(4);
    expect(result.volumeAcceleration5mZ).toBeGreaterThan(2);
  });

  it('handles a flat baseline without dividing by zero', () => {
    const result = computeVolumeAcceleration(25_000, [
      { volume5mUsd: 10_000 },
      { volume5mUsd: 10_000 },
      { volume5mUsd: 10_000 },
    ]);

    expect(result.volumeAcceleration5mZ).toBe(3);
  });
});
