import { randomBytes } from 'node:crypto';
import { expect, test as base, type Page } from '@playwright/test';
import { findRepoRoot, run } from './cli';
import { login } from './accounts';

export type Role = 'owner' | 'editor' | 'viewer';
export type ScenarioPosition = { listing: string; quantity?: string };
export type ScenarioSpace = {
  /** Suffix of the space name; labels sort A < B, which decides the default active space. */
  label: 'A' | 'B';
  /** Role of the scenario user; `null` = the user is not a member. */
  role: Role | null;
  positions: ScenarioPosition[];
};

export type Scenario = {
  username: string;
  password: string;
  spaces: Record<string, { name: string; id: string }>;
  /** Operator actions, like the admin CLI would do them, e.g. to change a role mid-test. */
  setRole: (label: string, role: Role) => Promise<void>;
  revoke: (label: string) => Promise<void>;
  signIn: (page: Page) => Promise<void>;
};

const root = findRepoRoot();
const admin = (args: string[], input?: string) => run(root, ['admin', '--', ...args], input);

// Reference-data listings created by `pnpm db:seed` in global setup.
export const AI: ScenarioPosition = { listing: 'AI.XPAR', quantity: '8' };
export const MC: ScenarioPosition = { listing: 'MC.XPAR', quantity: '3.5' };
export const MSFT_WATCH: ScenarioPosition = { listing: 'MSFT.XNAS' };
export const SHEL: ScenarioPosition = { listing: 'SHEL.XLON', quantity: '1234.5' };
export const MSFT: ScenarioPosition = { listing: 'MSFT.XNAS', quantity: '5' };
// Never priced in E2E (see global-setup.ts): a held position on it is missing from the total.
export const CW8_UNPRICED: ScenarioPosition = { listing: 'CW8.XPAR', quantity: '2' };
export const SAP: ScenarioPosition = { listing: 'SAP.XETR', quantity: '10' };

/**
 * Creates a brand-new user, spaces, memberships and positions for ONE test. Nothing is shared
 * with other tests, repeats (`--repeat-each`) or retries: every call uses fresh random names.
 */
async function createScenario(spaces: ScenarioSpace[]): Promise<Scenario> {
  const id = randomBytes(5).toString('hex');
  const username = `e2e-sp-${id}`;
  const password = `pw-${randomBytes(12).toString('hex')}`;
  await admin(['user:create', username], `${password}\n`);

  const created: Scenario['spaces'] = {};
  await Promise.all(
    spaces.map(async (space) => {
      const name = `E2E ${id} ${space.label}`;
      const out = await admin(['space:create', name]);
      const spaceId = /^Space created: .* \(([0-9a-f-]{36})\)$/m.exec(out)?.[1];
      if (!spaceId) throw new Error(`space:create printed no id for ${name}`);
      created[space.label] = { name, id: spaceId };
      if (space.role) await admin(['space:grant', name, username, space.role]);
      for (const p of space.positions) {
        const args = ['position:add', name, p.listing];
        await admin(p.quantity ? [...args, p.quantity] : args);
      }
    }),
  );

  const nameOf = (label: string) => {
    const space = created[label];
    if (!space) throw new Error(`No space ${label} in this scenario`);
    return space.name;
  };
  return {
    username,
    password,
    spaces: created,
    setRole: async (label, role) =>
      void (await admin(['space:grant', nameOf(label), username, role])),
    revoke: async (label) => void (await admin(['space:revoke', nameOf(label), username])),
    signIn: async (page) => {
      await page.goto('/login');
      await login(page, username, password);
      await expect(page).not.toHaveURL(/\/login/);
    },
  };
}

export const test = base.extend<{ scenario: (spaces: ScenarioSpace[]) => Promise<Scenario> }>({
  // eslint-disable-next-line no-empty-pattern
  scenario: async ({}, use) => {
    await use(createScenario);
  },
});
export { expect };
