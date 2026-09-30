import type { AccountKey } from './env';

export type ScenarioPosition = { listing: string; quantity?: string };
export type ScenarioSpace = {
  /** Suffix of the space name: "E2E <key> <run> <label>" (labels sort A < B). */
  label: 'A' | 'B';
  /** Role of the scenario user; `null` = the user is not a member. */
  role: 'owner' | 'editor' | 'viewer' | null;
  positions: ScenarioPosition[];
};

const AI: ScenarioPosition = { listing: 'AI.XPAR', quantity: '8' };
const MC: ScenarioPosition = { listing: 'MC.XPAR', quantity: '3.5' };
const MSFT_WATCH: ScenarioPosition = { listing: 'MSFT.XNAS' };
const SHEL: ScenarioPosition = { listing: 'SHEL.XLON', quantity: '1234.5' };
const SAP: ScenarioPosition = { listing: 'SAP.XETR', quantity: '10' };

/** Data created for each scenario account by global setup (reference data comes from db:seed). */
export const SCENARIO_SPACES: Partial<Record<AccountKey, ScenarioSpace[]>> = {
  'space-nav': [
    { label: 'A', role: 'owner', positions: [AI, MC, MSFT_WATCH, SHEL] },
    { label: 'B', role: 'editor', positions: [SAP] },
  ],
  'space-forbidden': [
    { label: 'A', role: 'owner', positions: [AI] },
    { label: 'B', role: null, positions: [SAP] },
  ],
  'space-edit': [{ label: 'A', role: 'editor', positions: [AI, MC] }],
  'space-clear': [{ label: 'A', role: 'owner', positions: [MC] }],
  'space-remove': [{ label: 'A', role: 'editor', positions: [AI, MC] }],
  'space-currency': [{ label: 'A', role: 'owner', positions: [SHEL] }],
  'space-viewer': [{ label: 'A', role: 'viewer', positions: [AI, MSFT_WATCH] }],
  'space-mobile': [
    { label: 'A', role: 'owner', positions: [AI, SHEL] },
    { label: 'B', role: 'viewer', positions: [SAP] },
  ],
};

export function spaceName(runId: string, key: AccountKey, label: string): string {
  return `E2E ${key} ${runId} ${label}`;
}
