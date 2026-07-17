import { describe, expect, it } from 'vitest'
import { calculateBmr, heightToCentimeters, normalizeWeightUnit, weightToKilograms } from '../src/bmr.js'

describe('BMR calculator', () => {
  it('calculates the male Mifflin-St Jeor estimate', () => {
    expect(calculateBmr({ age: 30, heightCm: 180, sex: 'male', weightKg: 80 })).toBe(1780)
  })

  it('calculates the female Mifflin-St Jeor estimate', () => {
    expect(calculateBmr({ age: 30, heightCm: 180, sex: 'female', weightKg: 80 })).toBe(1614)
  })

  it('returns null until every value is finite and within a supported adult range', () => {
    expect(calculateBmr({ age: 0, heightCm: 180, sex: 'male', weightKg: 80 })).toBeNull()
    expect(calculateBmr({ age: 30, heightCm: Number.NaN, sex: 'male', weightKg: 80 })).toBeNull()
    expect(calculateBmr({ age: 30, heightCm: 180, sex: 'male', weightKg: -1 })).toBeNull()
    expect(calculateBmr({ age: 121, heightCm: 180, sex: 'male', weightKg: 80 })).toBeNull()
    expect(calculateBmr({ age: 30.5, heightCm: 180, sex: 'male', weightKg: 80 })).toBeNull()
    expect(calculateBmr({ age: 30, heightCm: 276, sex: 'male', weightKg: 80 })).toBeNull()
    expect(calculateBmr({ age: 30, heightCm: 180, sex: 'male', weightKg: 501 })).toBeNull()
  })

  it('normalizes common tracker weight units', () => {
    expect(normalizeWeightUnit('KG')).toBe('kg')
    expect(normalizeWeightUnit('kilogrammes')).toBe('kg')
    expect(normalizeWeightUnit('lbs')).toBe('lb')
    expect(normalizeWeightUnit('stone')).toBe('st')
    expect(normalizeWeightUnit('cm')).toBeNull()
  })

  it('converts pounds and stone to kilograms', () => {
    expect(weightToKilograms(176.3698, 'lb')).toBeCloseTo(80, 4)
    expect(weightToKilograms(80 / 6.35029318, 'st')).toBeCloseTo(80, 8)
  })

  it('converts feet and inches to centimetres without accepting carried inches', () => {
    expect(heightToCentimeters(5, 10)).toBeCloseTo(177.8, 8)
    expect(heightToCentimeters(9, 0)).toBeCloseTo(274.32, 8)
    expect(heightToCentimeters(5, 12)).toBeNull()
    expect(heightToCentimeters(5.5, 0)).toBeNull()
  })
})
