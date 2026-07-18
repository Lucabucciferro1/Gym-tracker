import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface WebAppManifest {
  id?: string
  start_url?: string
  scope?: string
  display?: string
  icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>
}

const root = process.cwd()

describe('iPhone Home Screen app configuration', () => {
  it('requests a root-scoped standalone display mode', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(root, 'public/manifest.webmanifest'), 'utf8'),
    ) as WebAppManifest

    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    })
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icon-192.png', sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ src: '/icon-512.png', sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ src: '/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' }),
    ]))
  })

  it('links the manifest and iOS standalone metadata from the app shell', async () => {
    const html = await readFile(resolve(root, 'index.html'), 'utf8')

    expect(html).toContain('content="width=device-width, initial-scale=1.0, viewport-fit=cover"')
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('name="apple-mobile-web-app-title" content="Forge"')
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"')
  })

  it.each([
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-maskable-512.png', 512],
  ])('includes a correctly sized %s', async (filename, expectedSize) => {
    const icon = await readFile(resolve(root, 'public', filename))
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(icon.readUInt32BE(16)).toBe(expectedSize)
    expect(icon.readUInt32BE(20)).toBe(expectedSize)
  })
})
