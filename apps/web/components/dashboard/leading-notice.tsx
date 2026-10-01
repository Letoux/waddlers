import type { DashboardPeriod } from '@waddlers/contracts';
import { leadingMissingNotice } from '@/lib/dashboard/labels';

/** D20 notice, short or long form (see `leadingMissingNotice`); names sit in a disclosure when long. */
export function LeadingNotice({
  names,
  baseDate,
  period,
}: {
  names: string[];
  baseDate: string | null;
  period: DashboardPeriod;
}) {
  const notice = leadingMissingNotice(names, baseDate, period);
  if (!notice) return null;
  return (
    <li data-testid="leading-notice">
      {notice.text}
      {notice.kind === 'long' && (
        <details className="mt-1">
          <summary className="cursor-pointer">Voir les titres</summary>
          <p>{notice.names.join(', ')}</p>
        </details>
      )}
    </li>
  );
}
