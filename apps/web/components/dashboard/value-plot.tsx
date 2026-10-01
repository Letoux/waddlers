'use client';

import type { AppliedFxRate } from '@waddlers/contracts';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from 'recharts';
import { formatAxisDate, formatEurCompact } from '@/lib/dashboard/format';
import { spanDays, type ChartDatum } from '@/lib/dashboard/chart-model';
import { ChartTooltip } from './chart-tooltip';

/**
 * The plot only (loaded lazily by `HistoryChart` to keep Recharts out of the initial bundle).
 * One series, one hue from the `--chart-line` token (light and dark). A gap day is a real gap
 * (`connectNulls={false}`). The plot is decorative for assistive technology (`aria-hidden` on the
 * wrapper in the parent): the text summary and table carry the information.
 */
export default function ValuePlot({
  data,
  currentRates,
}: {
  data: ChartDatum[];
  currentRates: AppliedFxRate[] | null;
}) {
  const span = spanDays(data);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={data}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        accessibilityLayer={false}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => formatAxisDate(d, span)}
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: 'var(--border)' }}
          minTickGap={48}
        />
        <YAxis
          dataKey="value"
          width={64}
          domain={['auto', 'auto']}
          tickFormatter={(v: number) => formatEurCompact(v)}
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          content={(props) => <ChartTooltip {...props} currentRates={currentRates} />}
          cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--chart-line)"
          strokeWidth={2}
          fill="var(--chart-line)"
          fillOpacity={0.12}
          connectNulls={false}
          dot={false}
          activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2, fill: 'var(--chart-line)' }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
