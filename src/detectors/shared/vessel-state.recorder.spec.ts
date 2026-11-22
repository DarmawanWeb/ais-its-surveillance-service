import type { ZoneSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  FleetDirectory,
  makeTestVesselSnapshot,
  makeTestZone,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { MemoryVesselStates } from './__testing__/memory-storage.js';
import { VesselStateRecorder } from './vessel-state.recorder.js';

const MMSI = 525_000_777;
const SQUARE: ZoneSnapshotV1['geometry'] = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.1, 1],
      [104.1, 1.1],
      [104, 1.1],
      [104, 1],
    ],
  ],
};

function position(time: Date) {
  return {
    mmsi: MMSI,
    time,
    source: 'primary' as const,
    lat: 1.05,
    lon: 104.05,
    sog: 3,
    cog: 90,
    hdg: 90,
    navstatus: 0,
    predictedNavstatus: 0 as const,
    coastDistanceM: null,
    previous: null,
  };
}

describe('VesselStateRecorder', () => {
  it("stores the global and own-organization zones only (never another tenant's)", async () => {
    const ownOrg = newId();
    const zones = new ZoneIndex();
    const global = makeTestZone({
      kind: 'transhipment_area',
      geometry: SQUARE,
    });
    const own = makeTestZone({
      kind: 'anchorage',
      orgId: ownOrg,
      geometry: SQUARE,
    });
    const foreign = makeTestZone({
      kind: 'transhipment_area',
      orgId: newId(),
      geometry: SQUARE,
    });
    for (const zone of [global, own, foreign]) zones.upsert(zone);
    const fleet = new FleetDirectory();
    fleet.upsert(makeTestVesselSnapshot({ mmsi: MMSI, orgId: ownOrg }));
    const states = new MemoryVesselStates();
    const recorder = new VesselStateRecorder(states, {
      writeIntervalMs: 60_000,
    });

    await recorder.observe(
      { zones, fleet },
      position(new Date('2026-05-01T00:00:00Z')),
    );
    expect([...(states.states.get(MMSI)?.inZoneIds ?? [])].sort()).toEqual(
      [global.id, own.id].sort(),
    );
  });

  it('stores only global zones for a vessel without an organization', async () => {
    const zones = new ZoneIndex();
    const global = makeTestZone({ kind: 'port', geometry: SQUARE });
    zones.upsert(global);
    zones.upsert(
      makeTestZone({ kind: 'port', orgId: newId(), geometry: SQUARE }),
    );
    const states = new MemoryVesselStates();
    const recorder = new VesselStateRecorder(states, {
      writeIntervalMs: 60_000,
    });

    await recorder.observe(
      { zones, fleet: new FleetDirectory() },
      position(new Date('2026-05-01T00:00:00Z')),
    );
    expect(states.states.get(MMSI)?.inZoneIds).toEqual([global.id]);
  });
});
