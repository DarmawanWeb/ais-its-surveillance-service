import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import { bboxOf, pageOffsetOf, paginate } from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';

import { cellSizeDegrees } from '../statistics/statistics.service.js';
import type {
  FishingViolationHeatmapQueryDto,
  FishingViolationHeatmapView,
  FishingViolationView,
  FishingViolationYearsView,
  ListFishingViolationsQueryDto,
} from './fishing-violations.dto.js';
import { FishingViolationsRepository } from './fishing-violations.repository.js';

/**
 * `GET /surveillance/fishing-violations` (the historical map layer) with its
 * year facets and heat layer; the records are shared across tenants.
 */
@Injectable()
export class FishingViolationsService {
  constructor(private readonly violations: FishingViolationsRepository) {}

  async list(
    query: ListFishingViolationsQueryDto,
  ): Promise<Paginated<FishingViolationView>> {
    const { rows, total } = await this.violations.page(
      { bbox: bboxOf(query), year: query.year },
      pageOffsetOf(query),
      query.pageSize,
    );
    return paginate(rows, query, total);
  }

  async years(): Promise<FishingViolationYearsView> {
    const years = await this.violations.years();
    return {
      years,
      total: years.reduce((sum, entry) => sum + entry.count, 0),
    };
  }

  async heatmap(
    query: FishingViolationHeatmapQueryDto,
  ): Promise<FishingViolationHeatmapView> {
    const cellDeg = cellSizeDegrees(query.cellKm);
    const cells = await this.violations.heatmap(
      { bbox: bboxOf(query), year: query.year },
      cellDeg,
    );
    return {
      cells,
      cellKm: query.cellKm,
      cellDeg,
      year: query.year ?? null,
      total: cells.reduce((sum, cell) => sum + cell.count, 0),
    };
  }
}
