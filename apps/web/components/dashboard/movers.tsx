'use client';

import type { DashboardPeriod, Mover } from '@waddlers/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatLongDate, formatSignedPct } from '@/lib/dashboard/format';
import { useMovers } from '@/lib/dashboard/queries';
import { BlockError, BlockSkeleton, EmptyNote } from './block-states';
import { ChangeFigure } from './change-figure';

/**
 * Rows are static for now: the detail page is S9 (specs 14 wants a click to open it). When S9
 * lands, wrap the row content in a `Link` to the instrument page.
 */
function MoverRow({ mover }: { mover: Mover }) {
  return (
    <li
      data-testid="mover-row"
      title="Fiche détaillée bientôt disponible"
      className="flex items-start justify-between gap-3 py-2"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{mover.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {mover.symbol} · {mover.exchange.name}
        </p>
        <p className="text-xs text-muted-foreground">depuis le {formatLongDate(mover.baseDate)}</p>
      </div>
      <div className="shrink-0 text-right">
        <ChangeFigure raw={mover.performancePct} text={formatSignedPct(mover.performancePct)} />
        <p className="text-xs text-muted-foreground">en {mover.currency}</p>
      </div>
    </li>
  );
}

function MoversBlock({
  title,
  testId,
  movers,
  emptyText,
}: {
  title: string;
  testId: string;
  movers: Mover[];
  emptyText: string;
}) {
  return (
    <section aria-labelledby={`${testId}-title`} data-testid={testId}>
      <h3 id={`${testId}-title`} className="mb-1 text-sm font-semibold">
        {title}
      </h3>
      {movers.length === 0 ? (
        <EmptyNote>{emptyText}</EmptyNote>
      ) : (
        <ul className="divide-y">
          {movers.map((m) => (
            <MoverRow key={m.positionId} mover={m} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Movers({ spaceId, period }: { spaceId: string; period: DashboardPeriod }) {
  const query = useMovers(spaceId, period);
  const data = query.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Évolutions sur la période</h2>
        </CardTitle>
      </CardHeader>
      <CardContent aria-busy={query.isPending}>
        {query.isPending ? (
          <BlockSkeleton lines={5} label="Chargement des évolutions" />
        ) : !data ? (
          <BlockError query={query} testId="movers-error" />
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {query.isError && (
              <div className="md:col-span-2">
                <BlockError query={query} />
              </div>
            )}
            <MoversBlock
              title="Plus fortes progressions"
              testId="movers-gainers"
              movers={data.gainers}
              emptyText="Aucune progression disponible sur cette période."
            />
            <MoversBlock
              title="Plus fortes baisses"
              testId="movers-losers"
              movers={data.losers}
              emptyText="Aucune baisse disponible sur cette période."
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
