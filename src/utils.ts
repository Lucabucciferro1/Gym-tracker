import { format, isAfter, parseISO, subDays, subYears } from 'date-fns'
import type { DateRange } from './types'

export function formatDate(value: string, pattern = 'd MMM yyyy') {
  return format(parseISO(value), pattern)
}

export function toIsoDate(dateInput: string) {
  return new Date(`${dateInput}T12:00:00`).toISOString()
}

export function todayInput() {
  return format(new Date(), 'yyyy-MM-dd')
}

export function dateInput(value: string) {
  return format(parseISO(value), 'yyyy-MM-dd')
}

export function filterByRange<T extends { recordedAt: string }>(items: T[], range: DateRange): T[] {
  if (range === 'all') return items
  const threshold = range === '30d'
    ? subDays(new Date(), 30)
    : range === '90d'
      ? subDays(new Date(), 90)
      : subYears(new Date(), 1)
  return items.filter((item) => isAfter(parseISO(item.recordedAt), threshold))
}

export function percentChange(current?: number | null, previous?: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null
  return ((current - previous) / previous) * 100
}

export function estimatedOneRepMax(weight: number, reps: number) {
  if (reps <= 1) return weight
  return weight * (1 + reps / 30)
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
