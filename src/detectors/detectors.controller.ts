import { DetectorRegistry } from '@darmawanweb/ais-its-nest/analytics';
import { RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SurveillanceDetectorDto } from './detector-thresholds.js';

@ApiTags('detectors')
@Controller('surveillance/detectors')
export class DetectorsController {
  constructor(private readonly registry: DetectorRegistry) {}

  @Get()
  @RequirePermissions('surveillance:read')
  @ApiOperation({
    summary: 'Detectors of this instance: method ids and active thresholds',
    description:
      '`thresholds` lists the active `<ID>_*` configuration with a unit and a description per key; ' +
      '`config` is the same map without them (kept for older clients).',
  })
  @ApiOkResponse({
    type: [SurveillanceDetectorDto],
    description:
      'The detectors of this service with their method ids and active thresholds',
  })
  list(): SurveillanceDetectorDto[] {
    return this.registry
      .describe()
      .map((description) => new SurveillanceDetectorDto(description));
  }
}
