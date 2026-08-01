import { describe, expect, it } from 'vitest'
import { parsePlanDay, parsePositiveInteger, planDayOfWeek } from '../src/navigationState.js'

describe('navigation state helpers', () => {
  it('maps local JavaScript weekdays to Monday-first plan days', () => {
    expect(planDayOfWeek(new Date(2026, 6, 27))).toBe(0)
    expect(planDayOfWeek(new Date(2026, 7, 2))).toBe(6)
  })

  it('accepts only safe positive entity identifiers', () => {
    expect(parsePositiveInteger('42')).toBe(42)
    expect(parsePositiveInteger('0')).toBeNull()
    expect(parsePositiveInteger('-1')).toBeNull()
    expect(parsePositiveInteger('2.5')).toBeNull()
    expect(parsePositiveInteger('body-part')).toBeNull()
    expect(parsePositiveInteger(null)).toBeNull()
  })

  it('accepts only the seven Monday-first plan day values', () => {
    expect(parsePlanDay('0')).toBe(0)
    expect(parsePlanDay('6')).toBe(6)
    expect(parsePlanDay('7')).toBeNull()
    expect(parsePlanDay('-1')).toBeNull()
    expect(parsePlanDay('01')).toBeNull()
    expect(parsePlanDay(null)).toBeNull()
  })
})
