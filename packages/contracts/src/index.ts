import { oc } from '@orpc/contract';
import { z } from 'zod';

/** Browser-safe oRPC contract. Never import server code here. */

export const healthOutputSchema = z.object({
  /** `degraded` when a dependency (the database) is unavailable. */
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'unavailable']),
  /** ISO-8601 UTC timestamp of the check. */
  time: z.iso.datetime(),
});
export type HealthOutput = z.infer<typeof healthOutputSchema>;

export const contract = {
  health: oc.input(z.undefined()).output(healthOutputSchema),
};

export type Contract = typeof contract;
