import { addDays, compareDates, type PlainDate } from '@waddlers/domain';
import { z } from 'zod';
import { toPlainDate, toPositiveDecimalString } from './normalize';
import { redactSecrets } from './redact';
import {
  fail,
  ok,
  type CallOptions,
  type Clock,
  type FxBatch,
  type FxProvider,
  type ProviderResult,
} from './types';

/**
 * ECB euro foreign exchange reference rates (public, no key, `1 EUR = rate CCY`, published each
 * TARGET working day around 16:00 CET). Endpoints (checked 2026-09-30):
 *   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml   last ~90 days
 *   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml       full history since 1999
 * Both share one XML shape:
 *   <Cube><Cube time="2026-09-29"><Cube currency="USD" rate="1.1355"/>...</Cube>...</Cube>
 * Rates are ECB reference rates, not tradable quotes; days without publication are simply absent
 * (the domain layer applies a tolerance when it needs a rate for a non-publication day).
 */
export const ECB_BASE_URL = 'https://www.ecb.europa.eu/stats/eurofxref';
const HIST_90D_DAYS = 85; // margin under the ~90 calendar days the short file covers
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Row shape extracted from the XML, before field validation. */
const rowSchema = z.object({ date: z.string(), currency: z.string(), rate: z.string() });
type Row = z.infer<typeof rowSchema>;

/** Extracts (date, currency, rate) triples; anything not matching the Cube shape is ignored. */
export function extractRows(xml: string): Row[] {
  const rows: Row[] = [];
  const day = /<Cube\s+time="([^"]*)"\s*>([\s\S]*?)<\/Cube>/g;
  for (let d = day.exec(xml); d !== null; d = day.exec(xml)) {
    const rate = /<Cube\s+currency="([^"]*)"\s+rate="([^"]*)"\s*\/>/g;
    for (let r = rate.exec(d[2] ?? ''); r !== null; r = rate.exec(d[2] ?? '')) {
      const parsed = rowSchema.safeParse({ date: d[1], currency: r[1], rate: r[2] });
      if (parsed.success) rows.push(parsed.data);
    }
  }
  return rows;
}

/**
 * Pure normalization of an ECB XML document to EUR-based rates for [from, to]. Per-field
 * rejection: bad date, currency not `^[A-Z]{3}$` or EUR, rate not a positive finite number
 * (`N/A`, empty, 0, negative, NaN) or duplicated (currency, date) drops that row only.
 */
export function parseEcbXml(xml: string, range: { from: PlainDate; to: PlainDate }): FxBatch {
  const seen = new Set<string>();
  const rates: FxBatch['rates'] = [];
  let rejectedRows = 0;
  for (const row of extractRows(xml)) {
    const date = toPlainDate(row.date);
    const ratePerEur = toPositiveDecimalString(row.rate);
    const validCurrency = /^[A-Z]{3}$/.test(row.currency) && row.currency !== 'EUR';
    if (date === null || ratePerEur === null || !validCurrency) {
      rejectedRows += 1;
      continue;
    }
    if (compareDates(date, range.from) < 0 || compareDates(date, range.to) > 0) continue;
    const key = `${date}|${row.currency}`;
    if (seen.has(key)) {
      rejectedRows += 1;
      continue;
    }
    seen.add(key);
    rates.push({ date, currency: row.currency, ratePerEur });
  }
  rates.sort((a, b) => compareDates(a.date, b.date) || a.currency.localeCompare(b.currency));
  return { rates, rejectedRows };
}

export interface EcbFxOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
}

export class EcbFxProvider implements FxProvider {
  readonly name = 'ecb';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;

  constructor(options: EcbFxOptions = {}) {
    this.baseUrl = options.baseUrl ?? ECB_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  private urlFor(from: PlainDate): string {
    const today = this.clock().toISOString().slice(0, 10);
    const recent = compareDates(from, addDays(today, -HIST_90D_DAYS)) >= 0;
    return `${this.baseUrl}/eurofxref-${recent ? 'hist-90d' : 'hist'}.xml`;
  }

  async getDailyRates(
    from: PlainDate,
    to: PlainDate,
    options?: CallOptions,
  ): Promise<ProviderResult<FxBatch>> {
    const url = this.urlFor(from);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...(options?.signal ? { signal: options.signal } : {}),
        headers: { accept: 'application/xml, text/xml' },
        redirect: 'error',
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return fail(
        this.name,
        aborted ? 'timeout' : 'network',
        redactSecrets(`fetch failed: ${url}`),
      );
    }
    if (!response.ok) {
      const code =
        response.status === 429
          ? 'rate_limited'
          : response.status === 404
            ? 'not_found'
            : response.status >= 500
              ? 'upstream_error'
              : 'unsupported';
      return fail(this.name, code, `ECB responded ${response.status}`);
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) return fail(this.name, 'bad_payload', 'response too large');
    let xml: string;
    try {
      xml = await response.text();
    } catch {
      return fail(this.name, 'network', 'could not read the response body');
    }
    if (xml.length > MAX_BODY_BYTES) return fail(this.name, 'bad_payload', 'response too large');
    if (!xml.includes('<Cube')) return fail(this.name, 'bad_payload', 'not an ECB rates document');
    const batch = parseEcbXml(xml, { from, to });
    // asOf = the latest reference DATE in the batch (date precision; the exact publication time is not in the file).
    const latest = batch.rates.reduce<PlainDate | null>(
      (max, r) => (max === null || compareDates(r.date, max) > 0 ? r.date : max),
      null,
    );
    return ok(this.name, batch, latest ? new Date(`${latest}T00:00:00Z`) : this.clock());
  }
}
