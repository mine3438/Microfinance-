import {
  ROLES,
  approvalThresholdSchema,
  setApprovalThresholdRequestSchema,
  type RoleCode,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type SettingsRepository } from './settings-repository.js';

const thresholdListSchema = z.array(approvalThresholdSchema);
const roleParamSchema = z.enum(ROLES);

function roleOf(request: FastifyRequest): RoleCode {
  const parsed = roleParamSchema.safeParse((request.params as Record<string, unknown>)['role']);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a role this system has.');
  }
  return parsed.data;
}

export interface SettingsRouteOptions {
  readonly settings: SettingsRepository;
  readonly tokens: AccessTokenService;
}

/**
 * Institution settings.
 *
 * `settings.manage` writes, which the seeded catalogue gives the institution
 * administrator alone — an approval limit is the control that decides how much
 * anyone in the building may lend, and a role that could raise its own limit
 * would not be a limit.
 *
 * Reading is `loan.read`, because an officer needs to know what can be
 * sanctioned before submitting an application that will be refused.
 */
export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  const { settings, tokens } = options;
  const authenticated = authenticate(tokens);

  app.get(
    '/settings/approval-thresholds',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (request): Promise<unknown> => {
      const principal = principalOf(request);
      return thresholdListSchema.parse(
        await settings.approvalThresholds(principal.institutionId, principal.userId),
      );
    },
  );

  /** Set or clear one role's limit. Clearing it removes the authority. */
  app.put(
    '/settings/approval-thresholds/:role',
    { preHandler: [authenticated, requirePermission('settings.manage')] },
    async (request): Promise<unknown> => {
      const body = setApprovalThresholdRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That approval limit cannot be set as entered.');
      }

      const principal = principalOf(request);
      return thresholdListSchema.parse(
        await settings.setApprovalThreshold(
          principal.institutionId,
          principal.userId,
          roleOf(request),
          body.data.maxPrincipal,
        ),
      );
    },
  );
}
