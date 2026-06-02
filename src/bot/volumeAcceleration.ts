import type { TokenVolumeSnapshotRow } from '../storage/sqliteStore.js';

export interface VolumeAcceleration {
  volumeAcceleration5mZ?: number;
  volumeAccelerationSamples: number;
}

const MIN_BASELINE_SAMPLES = 3;

export function computeVolumeAcceleration(
  currentVolume5mUsd: number,
  snapshots: Pick<TokenVolumeSnapshotRow, 'volume5mUsd'>[],
): VolumeAcceleration {
  const baseline = snapshots
    .map((snapshot) => snapshot.volume5mUsd)
    .filter((value) => Number.isFinite(value) && value >= 0);

  if (baseline.length < MIN_BASELINE_SAMPLES) {
    return { volumeAccelerationSamples: baseline.length };
  }

  const mean = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
  const variance = baseline.reduce((sum, value) => sum + (value - mean) ** 2, 0) / baseline.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    const z = currentVolume5mUsd === mean ? 0 : currentVolume5mUsd > mean ? 3 : -3;
    return { volumeAcceleration5mZ: z, volumeAccelerationSamples: baseline.length };
  }

  return {
    volumeAcceleration5mZ: (currentVolume5mUsd - mean) / stdDev,
    volumeAccelerationSamples: baseline.length,
  };
}
