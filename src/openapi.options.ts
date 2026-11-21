import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from './service.js';

/** OpenAPI document of the service (`/docs`, `/openapi.json`, `pnpm openapi`). */
export const OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}`,
  version: SERVICE.version,
  description: SERVICE.description,
  tags: [
    {
      name: 'events',
      description: 'Surveillance events of the detectors and their review',
    },
    {
      name: 'transhipments',
      description: 'Detected transhipments (legacy result shape)',
    },
    { name: 'statistics', description: 'Heatmap and counts of the events' },
    {
      name: 'fishing-violations',
      description: 'Historical illegal-fishing records (map layer)',
    },
    { name: 'detectors', description: 'Detectors of the Detector SDK' },
    {
      name: 'methodology',
      description: 'Methods of the methodology catalog implemented here',
    },
  ],
};
