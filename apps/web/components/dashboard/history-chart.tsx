'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { DashboardHistoryOutput, DashboardPeriod, FxMode } from '@waddlers/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { chartSummary, sampleForTable, toChartData } from '@/lib/dashboard/chart-model';
import {
  formatEur,
  formatLongDate,
  formatSignedPct,
  fxRateLine,
  UNAVAILABLE,
} from '@/lib/dashboard/format';
import { joinNames } from '@/lib/dashboard/labels';
import { useHistory } from '@/lib/dashboard/queries';
import { BlockError, BlockSkeleton, StaleBadge } from './block-states';

const ValuePlot = dynamic(() => import('./value-plot'), {
  ssr: false,
  loading: () => <BlockSkeleton lines={4} label="Chargement du graphique" />,
});

const MODES: { id: FxMode; label: string }[] = [
  { id: 'historical', label: 'Taux historique' },
  { id: 'current', label: 'Taux actuel' },
];

function FxModeToggle({ value, onChange }: { value: FxMode; onChange: (m: FxMode) => void }) {
  return (
    <div role="group" aria-label="Taux de change du graphique" className="flex gap-1">
      {MODES.map((m) => (
        <Button
          key={m.id}
          size="sm"
          variant={value === m.id ? 'default' : 'outline'}
          aria-pressed={value === m.id}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </Button>
      ))}
    </div>
  );
}

function Notices({ history }: { history: DashboardHistoryOutput }) {
  const empty = history.points.every((p) => p.value === null);
  return (
    <ul className="grid gap-1 text-sm text-muted-foreground" data-testid="chart-notices">
      {history.leadingMissing.length > 0 && (
        <li>
          Pas de donnée avant la création de {joinNames(history.leadingMissing.map((p) => p.name))}.
        </li>
      )}
      {history.invalidPositions.length > 0 && (
        <li>
          Quantité invalide, position ignorée :{' '}
          {joinNames(history.invalidPositions.map((p) => p.name))}.
        </li>
      )}
      {empty && history.leadingMissing.length === 0 && history.invalidPositions.length === 0 && (
        <li>Aucune valeur à afficher sur cette période.</li>
      )}
    </ul>
  );
}

function A11yTable({ history }: { history: DashboardHistoryOutput }) {
  return (
    <div className="sr-only">
      <p data-testid="chart-summary">{chartSummary(history)}</p>
      <table>
        <caption>Valeur des positions actuelles (extrait)</caption>
        <thead>
          <tr>
            <th>Date</th>
            <th>Valeur</th>
            <th>Évolution</th>
          </tr>
        </thead>
        <tbody>
          {sampleForTable(history.points).map((p) => (
            <tr key={p.date}>
              <td>{formatLongDate(p.date)}</td>
              <td>{p.value === null ? UNAVAILABLE : formatEur(p.value)}</td>
              <td>{formatSignedPct(p.evolutionPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryChart({ spaceId, period }: { spaceId: string; period: DashboardPeriod }) {
  const [fxMode, setFxMode] = useState<FxMode>('historical');
  const query = useHistory(spaceId, period, fxMode);
  const history = query.data;
  const hasValues = !!history && history.points.some((p) => p.value !== null);
  const currentRates = history?.currentFxRates ?? [];

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle>
            <h2 data-testid="chart-title">
              Valeur des positions actuelles
              {history?.fxLabel
                ? ` ${history.fxLabel}`
                : fxMode === 'current'
                  ? ' au taux de change actuel'
                  : ''}
            </h2>
          </CardTitle>
          <FxModeToggle value={fxMode} onChange={setFxMode} />
        </div>
        {history && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {history.headline && <span>depuis le {formatLongDate(history.headline.baseDate)}</span>}
            {history.isStale && <StaleBadge testId="chart-stale-badge" />}
          </p>
        )}
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3" aria-busy={query.isPending}>
        {query.isPending ? (
          <BlockSkeleton lines={4} label="Chargement du graphique" />
        ) : !history ? (
          <BlockError query={query} testId="history-error" />
        ) : (
          <>
            {query.isError && <BlockError query={query} />}
            {hasValues && (
              <div data-testid="history-plot" aria-hidden className="h-64 w-full sm:h-80">
                <ValuePlot
                  data={toChartData(history.points)}
                  currentRates={history.currentFxRates}
                />
              </div>
            )}
            <A11yTable history={history} />
            <Notices history={history} />
            {currentRates.length > 0 && (
              <p className="text-sm text-muted-foreground" data-testid="current-fx">
                {currentRates
                  .map((r) => fxRateLine(r).text + (r.isStale ? ' (taux ancien)' : ''))
                  .join(' ; ')}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
