import { format, parseISO } from 'date-fns'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export interface ChartPoint {
  recordedAt: string
  value: number
  secondary?: number
}

export function ProgressChart({
  data,
  color,
  unit,
  secondaryLabel,
}: {
  data: ChartPoint[]
  color: string
  unit: string
  secondaryLabel?: string
}) {
  const chartData = data.map((point) => ({
    ...point,
    dateLabel: format(parseISO(point.recordedAt), 'd MMM'),
    fullDate: format(parseISO(point.recordedAt), 'd MMM yyyy'),
  }))

  const firstPoint = data[0]
  const latestPoint = data.at(-1)
  const accessibleSummary = (() => {
    if (!firstPoint || !latestPoint) return `Progress chart with no recorded values in ${unit}.`
    const firstDate = format(parseISO(firstPoint.recordedAt), 'd MMMM yyyy')
    const latestDate = format(parseISO(latestPoint.recordedAt), 'd MMMM yyyy')
    if (data.length === 1) {
      return `Progress chart with one record on ${firstDate}: ${firstPoint.value.toFixed(1)} ${unit}.`
    }

    const difference = latestPoint.value - firstPoint.value
    const changeSummary = difference > 0
      ? `an increase of ${difference.toFixed(1)} ${unit}`
      : difference < 0
        ? `a decrease of ${Math.abs(difference).toFixed(1)} ${unit}`
        : 'no overall change'
    const secondarySummary = secondaryLabel && latestPoint.secondary != null
      ? ` The latest ${secondaryLabel} is ${latestPoint.secondary.toFixed(1)} ${unit}.`
      : ''
    return `Progress chart with ${data.length} records from ${firstDate} to ${latestDate}. The first value is ${firstPoint.value.toFixed(1)} ${unit} and the latest is ${latestPoint.value.toFixed(1)} ${unit}, ${changeSummary}.${secondarySummary}`
  })()

  return (
    <div className="chart-frame" role="img" aria-label={accessibleSummary}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 10, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={`lineGlow-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.24} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 6" vertical={false} stroke="var(--border-subtle)" />
          <XAxis
            dataKey="dateLabel"
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
            minTickGap={34}
          />
          <YAxis
            domain={['auto', 'auto']}
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
            tickFormatter={(value: number) => `${value} ${unit}`}
          />
          <Tooltip
            cursor={{ stroke: color, strokeDasharray: '4 4', strokeOpacity: 0.45 }}
            contentStyle={{
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: '0 14px 40px rgba(23, 32, 27, .12)',
              background: 'var(--surface)',
            }}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate ?? ''}
            formatter={(value, name) => [
              `${Number(value).toFixed(1)} ${unit}`,
              name === 'secondary' ? secondaryLabel ?? 'Estimated 1RM' : 'Recorded',
            ]}
          />
          {secondaryLabel && (
            <Line
              type="monotone"
              dataKey="secondary"
              stroke="var(--chart-secondary)"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, fill: 'var(--surface)' }}
            />
          )}
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={3}
            dot={chartData.length < 16 ? { r: 3, strokeWidth: 2, fill: 'var(--surface)' } : false}
            activeDot={{ r: 5, strokeWidth: 3, fill: 'var(--surface)' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
