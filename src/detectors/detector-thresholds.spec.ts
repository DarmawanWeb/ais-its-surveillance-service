import { describe, expect, it } from 'vitest';

import { anomalyConfigSchema } from './anomaly/anomaly.detector.js';
import { darkConfigSchema } from './dark/dark.detector.js';
import { DETECTOR_THRESHOLDS, thresholdsOf } from './detector-thresholds.js';
import { fishingConfigSchema } from './fishing/fishing.detector.js';
import { geofenceConfigSchema } from './geofence/geofence.detector.js';
import { transhipmentConfigSchema } from './transhipment/transhipment.config.js';

/** The default configuration of each detector (`<ID>_*` unset). */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  transhipment: transhipmentConfigSchema.parse({}),
  anomaly: anomalyConfigSchema.parse({}),
  dark: darkConfigSchema.parse({}),
  geofence: geofenceConfigSchema.parse({}),
  fishing: fishingConfigSchema.parse({}),
};

describe('detector thresholds', () => {
  it('describes every configuration key of every detector, and nothing else', () => {
    expect(Object.keys(DETECTOR_THRESHOLDS).sort()).toEqual(
      Object.keys(DEFAULTS).sort(),
    );
    for (const [id, config] of Object.entries(DEFAULTS))
      expect(Object.keys(DETECTOR_THRESHOLDS[id] ?? {}).sort()).toEqual(
        Object.keys(config).sort(),
      );
  });

  it('lists the active values with units and descriptions', () => {
    const thresholds = thresholdsOf('transhipment', DEFAULTS.transhipment);
    expect(thresholds).toContainEqual({
      key: 'ACCURACY_THRESHOLD',
      value: 70,
      unit: 'percent',
      description: 'Minimum score of an illegal transhipment',
    });
    expect(thresholds).toContainEqual(
      expect.objectContaining({ key: 'SOURCES', value: ['batam'], unit: null }),
    );
    expect(thresholdsOf('geofence', DEFAULTS.geofence)).toContainEqual(
      expect.objectContaining({ key: 'USE_BUFFER', value: true }),
    );
    expect(thresholdsOf('dark', null)).toEqual([]);
  });
});
