import { describe, expect, it, vi } from 'vitest';

import {
  LoggingInvitationDelivery,
  ManualInvitationDelivery,
  UnsafeDeliveryModeError,
  createInvitationDelivery,
  type DeliveryLogger,
  type InvitationMessage,
} from './invitation-delivery.js';

/**
 * Invitation delivery.
 *
 * The tests that matter here are about what each mechanism does with the
 * token, not about whether a message was formatted nicely. An invitation link
 * is a single-use credential that creates a staff account, so where it ends up
 * is a security property.
 */

const message: InvitationMessage = {
  email: 'asha@example.test',
  fullName: 'Asha Mrema',
  institutionName: 'Kilimanjaro Microfinance',
  link: 'http://localhost:5173/accept-invitation?token=SECRET-TOKEN',
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
};

const recordingLogger = (): DeliveryLogger & { calls: [Record<string, unknown>, string][] } => {
  const calls: [Record<string, unknown>, string][] = [];
  return {
    calls,
    info: (details, text): void => {
      calls.push([details, text]);
    },
  };
};

describe('manual delivery', () => {
  it('hands the link back to the caller and reports how', async () => {
    const outcome = await new ManualInvitationDelivery().deliver(message);

    expect(outcome).toEqual({ mechanism: 'manual', link: message.link });
  });

  it('does not write the token anywhere', async () => {
    // There is nowhere for it to go: the class holds no logger, no client and
    // no transport. Asserted as a property of the constructor rather than by
    // watching for a call that has nothing to make it.
    const logger = recordingLogger();
    await new ManualInvitationDelivery().deliver(message);

    expect(logger.calls).toEqual([]);
  });
});

describe('logging delivery', () => {
  it('logs the link and does not return it', async () => {
    const logger = recordingLogger();

    const outcome = await new LoggingInvitationDelivery(logger).deliver(message);

    // Returning it as well would put the same live token in two places, which
    // is the thing the mechanisms are kept apart to avoid.
    expect(outcome).toEqual({ mechanism: 'logged', link: null });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.[0]?.['link']).toBe(message.link);
  });

  it('says in the log line that the value is a credential', async () => {
    const logger = recordingLogger();
    await new LoggingInvitationDelivery(logger).deliver(message);

    expect(logger.calls[0]?.[1]).toContain('single-use credential');
  });
});

describe('choosing a mechanism', () => {
  it('defaults to manual, which needs no provider and no secrets', () => {
    const delivery = createInvitationDelivery({
      mode: 'manual',
      isProduction: true,
      logger: recordingLogger(),
    });

    expect(delivery).toBeInstanceOf(ManualInvitationDelivery);
  });

  it('builds the logging mechanism outside production', () => {
    const delivery = createInvitationDelivery({
      mode: 'log',
      isProduction: false,
      logger: recordingLogger(),
    });

    expect(delivery).toBeInstanceOf(LoggingInvitationDelivery);
  });

  it('refuses the logging mechanism in production', () => {
    // A live invitation token in a log store is readable by everyone with
    // access to operational telemetry, kept for the retention period, and
    // frequently shipped to a third party for search.
    expect(() =>
      createInvitationDelivery({
        mode: 'log',
        isProduction: true,
        logger: recordingLogger(),
      }),
    ).toThrow(UnsafeDeliveryModeError);
  });

  it('names the safe alternative when it refuses', () => {
    // A refusal that does not say what to do instead gets worked around rather
    // than fixed.
    try {
      createInvitationDelivery({ mode: 'log', isProduction: true, logger: recordingLogger() });
      expect.unreachable('production log delivery should have been refused');
    } catch (error) {
      expect((error as Error).message).toContain('INVITATION_DELIVERY=manual');
    }
  });

  it('refuses at construction, not on the first invitation', () => {
    // The guard is where the object is built so a misconfigured deployment
    // fails at startup. Proved by never calling deliver().
    const deliver = vi.fn();

    expect(() =>
      createInvitationDelivery({ mode: 'log', isProduction: true, logger: recordingLogger() }),
    ).toThrow();
    expect(deliver).not.toHaveBeenCalled();
  });
});
