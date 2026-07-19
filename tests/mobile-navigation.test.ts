import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOBILE_NAVIGATION,
  navigationPathMatches,
  normalizeMobileNavigation,
} from '../src/mobileNavigation.js'
import type { MobileNavigationDestination } from '../src/types.js'

describe('mobile navigation client safeguards', () => {
  it('uses the current four shortcuts as the deterministic default', () => {
    expect(normalizeMobileNavigation(undefined, 'user')).toEqual(DEFAULT_MOBILE_NAVIGATION)
  })

  it('deduplicates incomplete data and fills every slot with eligible defaults', () => {
    expect(normalizeMobileNavigation(['meals', 'meals', 'sharing'], 'user')).toEqual([
      'meals',
      'sharing',
      'dashboard',
      'measurements',
    ])
  })

  it('removes an admin-only shortcut for members without disturbing other saved choices', () => {
    expect(normalizeMobileNavigation(
      ['meals', 'admin', 'sharing', 'lifts'],
      'user',
    )).toEqual(['meals', 'sharing', 'lifts', 'dashboard'])
  })

  it('preserves an administrator shortcut for an administrator', () => {
    const saved: MobileNavigationDestination[] = ['admin', 'meals', 'sharing', 'dashboard']
    expect(normalizeMobileNavigation(saved, 'admin')).toEqual(saved)
  })

  it('matches exact app routes while tolerating a trailing slash', () => {
    expect(navigationPathMatches('/meals/', '/meals')).toBe(true)
    expect(navigationPathMatches('/', '/')).toBe(true)
    expect(navigationPathMatches('/measurements', '/')).toBe(false)
  })
})
