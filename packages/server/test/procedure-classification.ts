import { traverseContractProcedures } from '@orpc/server';
import { contract } from '@waddlers/contracts';
import { z } from 'zod';

/**
 * Every procedure of the contract MUST be classified here; a new procedure fails the tests until
 * someone decides how it is protected:
 * - `public`: reachable without a session (must equal PUBLIC_PROCEDURES);
 * - `user`: authed, scoped to the caller by construction (never takes a space or row id);
 * - `space`: takes `spaceId`, built from `spaceScoped(minRole)`, and MUST be in the IDOR matrix.
 */
export type Classification = 'public' | 'user' | 'space';

export const CLASSIFICATION: Record<string, Classification> = {
  health: 'public',
  'auth.login': 'public',
  systemStatus: 'user',
  'auth.logout': 'user',
  'auth.me': 'user',
  'auth.changePassword': 'user',
  'spaces.list': 'user',
  'spaces.get': 'space',
  'spaces.setActive': 'space',
  'positions.list': 'space',
  'positions.setQuantity': 'space',
  'positions.remove': 'space',
  'dashboard.summary': 'space',
  'dashboard.history': 'space',
  'dashboard.movers': 'space',
};

/**
 * Non-space procedures allowed to have a space/position-looking input key, with the reason. Empty
 * on purpose: anything naming a space or position must be `space`-classified.
 */
export const SPACE_LIKE_KEY_JUSTIFICATIONS: Record<string, string> = {};

export function allContractPaths(): string[] {
  const paths: string[] = [];
  traverseContractProcedures({ path: [], router: contract }, ({ path }) => {
    paths.push(path.join('.'));
  });
  return paths.sort();
}

/** Every property name found anywhere in the JSON Schema of each procedure's input. */
export function inputKeysByPath(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  traverseContractProcedures({ path: [], router: contract }, ({ path, contract: proc }) => {
    const schema = (proc as { '~orpc': { inputSchema?: z.ZodType } })['~orpc'].inputSchema;
    const keys = new Set<string>();
    if (schema) {
      const json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
      collectKeys(json, keys);
    }
    out[path.join('.')] = [...keys].sort();
  });
  return out;
}

function collectKeys(node: unknown, keys: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, keys);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        for (const prop of Object.keys(value)) keys.add(prop);
      }
      collectKeys(value, keys);
    }
  }
}
