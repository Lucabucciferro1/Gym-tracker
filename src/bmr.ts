import type { BmrFormulaSex, BmrWeightUnit } from './types.js'

export type { BmrFormulaSex } from './types.js'

export type WeightUnit = BmrWeightUnit

export interface BmrInput {
  age: number
  heightCm: number
  sex: BmrFormulaSex
  weightKg: number
}

const POUNDS_TO_KILOGRAMS = 0.45359237
const STONE_TO_KILOGRAMS = 6.35029318

export function normalizeWeightUnit(unit: string): WeightUnit | null {
  const normalized = unit.trim().toLowerCase().replace(/[.\s_-]/g, '')

  if (['kg', 'kgs', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'].includes(normalized)) {
    return 'kg'
  }
  if (['lb', 'lbs', 'pound', 'pounds'].includes(normalized)) return 'lb'
  if (['st', 'stone', 'stones'].includes(normalized)) return 'st'
  return null
}

export function weightToKilograms(value: number, unit: WeightUnit): number {
  if (unit === 'lb') return value * POUNDS_TO_KILOGRAMS
  if (unit === 'st') return value * STONE_TO_KILOGRAMS
  return value
}

export function heightToCentimeters(feet: number, inches: number): number | null {
  if (
    !Number.isFinite(feet)
    || !Number.isInteger(feet)
    || !Number.isFinite(inches)
    || feet < 0
    || inches < 0
    || inches >= 12
  ) {
    return null
  }
  return ((feet * 12) + inches) * 2.54
}

export function calculateBmr({ age, heightCm, sex, weightKg }: BmrInput): number | null {
  if (
    !Number.isFinite(age)
    || !Number.isInteger(age)
    || !Number.isFinite(heightCm)
    || !Number.isFinite(weightKg)
    || age < 18
    || age > 120
    || heightCm < 100
    || heightCm > 275
    || weightKg < 20
    || weightKg > 500
  ) {
    return null
  }

  const sexConstant = sex === 'male' ? 5 : -161
  const estimate = Math.round((10 * weightKg) + (6.25 * heightCm) - (5 * age) + sexConstant)
  return estimate > 0 ? estimate : null
}
