/**
 * Ids of the methodology catalog methods this service implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions, the detectors'
 * `methodIds` and the README section "Methodology & references".
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  'geo.haversine_distance',
  'transhipment.speed_priority',
  'transhipment.location_priority',
  'transhipment.heading_priority',
  'transhipment.candidate_queue',
  'transhipment.route_interpolation',
  'transhipment.sliding_window',
  'transhipment.weighted_score',
  'transhipment.accuracy',
  'transhipment.priority_distribution',
  'anomaly.navstatus_mismatch',
  'dark.ais_gap',
  'geo.geofence_enter',
  'fishing.loitering',
  'fishing.apprehensions_2015_2017',
];
