/**
 * How an invitation reaches the person invited.
 *
 * No supplied document names an email provider, a sending domain, or who pays
 * for one. Integrating SendGrid, Resend, Mailgun or a bare SMTP host would be
 * choosing all three on the institution's behalf, and the choice is not
 * reversible in the way a wrong colour is: it puts a third party in the path of
 * a credential that creates staff accounts.
 *
 * So this is an interface with two implementations, neither of which is a
 * provider:
 *
 * - **manual** — the API returns the invitation link to the administrator who
 *   created it, once, and they convey it. For a Tier II provider whose new loan
 *   officer is in the next room this is not a placeholder; it is how the thing
 *   actually happens, and it needs no secrets, no sending domain and no vendor.
 * - **logged** — the link goes to the server log instead. For development, and
 *   refused outright in production, where writing a live credential into a log
 *   store is worse than not sending it at all.
 *
 * Adding SMTP later means writing one more class against {@link
 * InvitationDelivery} and one more case in {@link createInvitationDelivery}.
 * Nothing above this interface knows which is in use — except that `manual`
 * hands the link back, which the contract models explicitly rather than
 * pretending every mechanism is alike.
 */

/** What an implementation is told about the invitation it is delivering. */
export interface InvitationMessage {
  readonly email: string;
  readonly fullName: string;
  readonly institutionName: string;
  /** The acceptance URL, carrying the single-use token. Never stored. */
  readonly link: string;
  readonly expiresAt: Date;
}

/**
 * What happened to it.
 *
 * `link` is non-null only where the mechanism did not deliver the invitation
 * itself and is handing it back to the sender to convey. Any real transport
 * returns null, because a transport that both sends the token and echoes it has
 * doubled the number of places it exists.
 */
export interface DeliveryOutcome {
  readonly mechanism: 'manual' | 'logged';
  readonly link: string | null;
}

export interface InvitationDelivery {
  deliver(message: InvitationMessage): Promise<DeliveryOutcome>;
}

/**
 * Hand the link back to the administrator who created the invitation.
 *
 * The token is in plaintext exactly once, in a response to an authenticated
 * caller who holds `user.invite`, over the same TLS connection that carried
 * their access token. It is not written to a log, not stored, and not sent to
 * any third party — only its hash reaches the database.
 */
export class ManualInvitationDelivery implements InvitationDelivery {
  public deliver(message: InvitationMessage): Promise<DeliveryOutcome> {
    return Promise.resolve({ mechanism: 'manual', link: message.link });
  }
}

/** Somewhere a log line can go. Narrower than a logger, so tests need no server. */
export interface DeliveryLogger {
  info(details: Record<string, unknown>, message: string): void;
}

/**
 * Write the link to the server log.
 *
 * Development only. {@link createInvitationDelivery} refuses to build this in
 * production, because a log store is read by more people than an inbox, kept
 * longer, and frequently shipped to a third party for search — so a live
 * invitation token in a log line is a credential disclosed to everyone with
 * access to operational telemetry.
 */
export class LoggingInvitationDelivery implements InvitationDelivery {
  public constructor(private readonly logger: DeliveryLogger) {}

  public deliver(message: InvitationMessage): Promise<DeliveryOutcome> {
    this.logger.info(
      {
        email: message.email,
        institution: message.institutionName,
        expiresAt: message.expiresAt.toISOString(),
        link: message.link,
      },
      'Invitation created. This link is a single-use credential; development mode only.',
    );
    return Promise.resolve({ mechanism: 'logged', link: null });
  }
}

/** Which mechanism to build. Mirrors the `INVITATION_DELIVERY` setting. */
export type InvitationDeliveryMode = 'manual' | 'log';

export interface DeliveryOptions {
  readonly mode: InvitationDeliveryMode;
  readonly isProduction: boolean;
  readonly logger: DeliveryLogger;
}

/** Raised when the configured mechanism may not be used in this environment. */
export class UnsafeDeliveryModeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsafeDeliveryModeError';
  }
}

/**
 * Build the configured mechanism, refusing an unsafe combination.
 *
 * The production guard is the same shape as `COOKIE_SECURE`'s: a setting whose
 * unsafe value is permitted outside production and refused inside it, checked
 * where the object is constructed so a misconfigured deployment fails at
 * startup rather than on the first invitation.
 */
export function createInvitationDelivery(options: DeliveryOptions): InvitationDelivery {
  if (options.mode === 'log') {
    if (options.isProduction) {
      throw new UnsafeDeliveryModeError(
        'INVITATION_DELIVERY=log writes a live single-use invitation token to the server log, ' +
          'which is readable by everyone with access to operational telemetry. It is refused in ' +
          'production. Use INVITATION_DELIVERY=manual, which returns the link once to the ' +
          'administrator who created the invitation.',
      );
    }
    return new LoggingInvitationDelivery(options.logger);
  }

  return new ManualInvitationDelivery();
}
