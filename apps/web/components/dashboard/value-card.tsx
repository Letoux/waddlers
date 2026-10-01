'use client';

import { TriangleAlert } from 'lucide-react';
import type { DashboardPeriod, DashboardSummaryOutput } from '@waddlers/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatEur,
  formatLongDate,
  formatNumericDate,
  formatSignedEur,
  formatSignedPct,
  UNAVAILABLE,
} from '@/lib/dashboard/format';
import { deltaEndNote } from '@/lib/dashboard/delta-end';
import { joinNames, missingReasonLabel } from '@/lib/dashboard/labels';
import { useSummary } from '@/lib/dashboard/queries';
import { BlockError, BlockSkeleton, StaleBadge } from './block-states';
import { ChangeFigure } from './change-figure';

function PartialWarning({ missing }: { missing: DashboardSummaryOutput['missing'] }) {
  return (
    <Alert data-testid="partial-warning" role="status">
      <TriangleAlert />
      <AlertTitle>Total partiel</AlertTitle>
      <AlertDescription>
        <p>
          {missing.length === 1
            ? '1 position n’est pas comptée dans ce total :'
            : `${missing.length} positions ne sont pas comptées dans ce total :`}
        </p>
        <ul className="list-disc pl-5">
          {missing.map((m) => (
            <li key={m.positionId}>
              {m.name} ({missingReasonLabel(m.reason)})
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function Freshness({ freshness }: { freshness: DashboardSummaryOutput['freshness'] }) {
  const details = [
    ...freshness.stalePositions.map((p) => `${p.name} (cours du ${formatNumericDate(p.asOf)})`),
    ...freshness.staleFx.map((f) => `taux ${f.currency} du ${formatNumericDate(f.date)}`),
  ];
  return (
    <div className="grid gap-1 text-sm text-muted-foreground" data-testid="freshness">
      <p className="flex flex-wrap items-center gap-2">
        <span>
          Données au{' '}
          <span data-testid="as-of">
            {freshness.oldestPriceDate ? formatLongDate(freshness.oldestPriceDate) : UNAVAILABLE}
          </span>
        </span>
        {freshness.isStale && <StaleBadge testId="stale-badge" />}
      </p>
      {freshness.isStale && details.length > 0 && <p>Données anciennes : {details.join(', ')}.</p>}
    </div>
  );
}

function Notices({ summary }: { summary: DashboardSummaryOutput }) {
  if (summary.leadingMissing.length === 0 && summary.invalidPositions.length === 0) return null;
  return (
    <ul className="grid gap-1 text-sm text-muted-foreground" data-testid="value-notices">
      {summary.leadingMissing.length > 0 && (
        <li>
          Pas de donnée avant la création de {joinNames(summary.leadingMissing.map((p) => p.name))}.
        </li>
      )}
      {summary.invalidPositions.length > 0 && (
        <li>
          Quantité invalide, position ignorée :{' '}
          {joinNames(summary.invalidPositions.map((p) => p.name))}.
        </li>
      )}
    </ul>
  );
}

function Delta({ summary }: { summary: DashboardSummaryOutput }) {
  const { change } = summary;
  // Card delta is always historical FX (D23), whatever the chart's FX mode.
  const endsAt = deltaEndNote(change, summary.freshness.oldestPriceDate);
  if (!change) {
    // D23: a partial total has no delta (it would describe another set of positions).
    const why = summary.isComplete
      ? 'pas assez de données sur la période'
      : 'total partiel, évolution non calculée';
    return (
      <p className="text-sm text-muted-foreground" data-testid="period-delta">
        Évolution : {UNAVAILABLE} ({why})
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1" data-testid="period-delta">
      <ChangeFigure
        raw={change.change.amount}
        text={formatSignedEur(change.change.amount)}
        className="text-xl"
        testId="delta-amount"
      />
      <ChangeFigure
        raw={change.changePct}
        text={formatSignedPct(change.changePct)}
        className="text-xl"
        testId="delta-pct"
      />
      <span className="text-sm text-muted-foreground">
        depuis le <span data-testid="base-date">{formatLongDate(change.baseDate)}</span>
        {endsAt && (
          <>
            {' '}
            <span data-testid="delta-end">au {formatLongDate(endsAt)}</span>
          </>
        )}
      </span>
    </div>
  );
}

export function ValueCard({ spaceId, period }: { spaceId: string; period: DashboardPeriod }) {
  const query = useSummary(spaceId, period);
  const summary = query.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Valeur suivie</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3" aria-busy={query.isPending}>
        {query.isPending ? (
          <BlockSkeleton lines={2} label="Chargement de la valeur suivie" />
        ) : !summary ? (
          <BlockError query={query} testId="summary-error" />
        ) : (
          <>
            {query.isError && <BlockError query={query} />}
            <p className="text-4xl font-semibold tabular-nums" data-testid="total-value">
              {formatEur(summary.total.amount)}
            </p>
            {summary.heldCount === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucune quantité renseignée : pas de valeur à afficher.
              </p>
            ) : (
              <Delta summary={summary} />
            )}
            {!summary.isComplete && summary.missing.length > 0 && (
              <PartialWarning missing={summary.missing} />
            )}
            <Notices summary={summary} />
            <Freshness freshness={summary.freshness} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
