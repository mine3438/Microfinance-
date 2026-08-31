import {
  type Complaint,
  type ComplaintListQuery,
  type ComplaintNature,
  type LogComplaintRequest,
  type Page,
  type ReferComplaintRequest,
  type ResolveComplaintRequest,
} from '@mfi/contracts';
import { type Principal } from '@mfi/identity';

import { notFound, ruleViolation } from '../../http/errors.js';
import { type ComplaintRepository } from './complaint-repository.js';

/**
 * Logging, resolving and referring a complaint.
 *
 * The rules here are about **dates**, because MSP2-06 is a movement statement
 * and a date is what decides which line a complaint lands on. A resolution
 * dated before the complaint arrived, or a referral dated in the future, would
 * put a figure on the wrong quarter's return — and the wrong quarter's return
 * may already have been filed.
 *
 * Everything else is the schema's job: the nature must be one BOT publishes,
 * the branch must belong to the institution, a resolution must name a route.
 */

export async function listComplaintNatures(
  principal: Principal,
  complaints: ComplaintRepository,
): Promise<ComplaintNature[]> {
  return complaints.natures(principal.institutionId, principal.userId);
}

export async function listComplaints(
  principal: Principal,
  filters: ComplaintListQuery,
  complaints: ComplaintRepository,
): Promise<Page<Complaint>> {
  const page = await complaints.list(principal.institutionId, principal.userId, filters);
  return { items: [...page.items], nextCursor: page.nextCursor };
}

export async function getComplaint(
  principal: Principal,
  id: string,
  complaints: ComplaintRepository,
): Promise<Complaint> {
  const complaint = await complaints.find(principal.institutionId, principal.userId, id);
  if (complaint === null) {
    throw notFound('That complaint does not exist.');
  }
  return complaint;
}

export async function logComplaint(
  principal: Principal,
  request: LogComplaintRequest,
  complaints: ComplaintRepository,
  now: () => Date = () => new Date(),
): Promise<Complaint> {
  refuseFutureDate(request.receivedOn, now, 'A complaint cannot be received in the future.');

  return complaints.log(principal.institutionId, principal.userId, request);
}

export async function resolveComplaint(
  principal: Principal,
  id: string,
  request: ResolveComplaintRequest,
  complaints: ComplaintRepository,
  now: () => Date = () => new Date(),
): Promise<Complaint> {
  refuseFutureDate(request.resolvedOn, now, 'A complaint cannot be resolved in the future.');

  const complaint = await getComplaint(principal, id, complaints);
  if (request.resolvedOn < complaint.receivedOn) {
    throw ruleViolation(
      `This complaint was received on ${complaint.receivedOn} and cannot have been resolved on ` +
        `${request.resolvedOn}. BOT’s roll-forward on MSP2-06 depends on the two being in order.`,
    );
  }

  return complaints.resolve(principal.institutionId, principal.userId, id, request);
}

export async function referComplaint(
  principal: Principal,
  id: string,
  request: ReferComplaintRequest,
  complaints: ComplaintRepository,
  now: () => Date = () => new Date(),
): Promise<Complaint> {
  refuseFutureDate(request.referredOn, now, 'A complaint cannot be referred in the future.');

  const complaint = await getComplaint(principal, id, complaints);
  if (request.referredOn < complaint.receivedOn) {
    throw ruleViolation(
      `This complaint was received on ${complaint.receivedOn} and cannot have been referred on ` +
        `${request.referredOn}.`,
    );
  }

  return complaints.refer(principal.institutionId, principal.userId, id, request);
}

/**
 * A date that has not happened yet.
 *
 * Refused rather than accepted, because MSP2-06 counts as at a quarter end: a
 * referral dated next month would appear on no return until that month arrives,
 * and then on one that may have been filed already.
 */
function refuseFutureDate(date: string, now: () => Date, message: string): void {
  const today = now().toISOString().slice(0, 10);
  if (date > today) {
    throw ruleViolation(`${message} Today is ${today}.`);
  }
}
