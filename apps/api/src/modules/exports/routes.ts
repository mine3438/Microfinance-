import { uuidSchema } from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type FilingRepository } from '../filings/filing-repository.js';
import { type CellMapRepository } from './cell-map.js';
import { type ExportRepository } from './export-repository.js';
import { exportFiledReturn } from './use-cases.js';

const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ExportRouteOptions {
  readonly filings: FilingRepository;
  readonly exports: ExportRepository;
  readonly cellMaps: CellMapRepository;
  readonly tokens: AccessTokenService;
}

function idOf(request: FastifyRequest): string {
  const parsed = uuidSchema.safeParse((request.params as Record<string, unknown>)['id']);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a filing identifier.');
  }
  return parsed.data;
}

/**
 * Downloading a filed return as BOT's own workbook.
 *
 * `report.read`, the same authority as reading the archived document: the
 * workbook is a rendering of a return that has already been filed, and deciding
 * to file it was the `report.generate` act that produced it.
 *
 * The filename is quoted and built from the MSP code and period rather than
 * from anything a caller supplies, so there is no header this route can be made
 * to inject into.
 */
export function registerExportRoutes(app: FastifyInstance, options: ExportRouteOptions): void {
  const { filings, exports, cellMaps, tokens } = options;
  const authenticated = authenticate(tokens);

  app.get(
    '/filings/:id/workbook',
    { preHandler: [authenticated, requirePermission('report.read')] },
    async (request, reply): Promise<Buffer> => {
      const workbook = await exportFiledReturn(
        principalOf(request),
        idOf(request),
        filings,
        exports,
        cellMaps,
      );

      void reply
        .type(XLSX_MEDIA_TYPE)
        .header('content-disposition', `attachment; filename="${workbook.filename}"`);

      return workbook.bytes;
    },
  );
}
