import type { Paginated } from '@darmawanweb/ais-its-contracts/api';
import { bboxOf, pageOffsetOf, paginate } from '@darmawanweb/ais-its-nest/http';
import { Injectable } from '@nestjs/common';

import type {
  FishingViolationView,
  ListFishingViolationsQueryDto,
} from './fishing-violations.dto.js';
import { FishingViolationsRepository } from './fishing-violations.repository.js';

/** `GET /surveillance/fishing-violations`: the historical map layer. */
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
}
