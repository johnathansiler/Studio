import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArrangeBottomSheet } from '../ui/ArrangeBottomSheet'
import { SheetClose, SheetHeader } from '../ui/SheetClose'

describe('sheet close mark', () => {
  it('uses an X with the accessible name Close', () => {
    const html = renderToStaticMarkup(createElement(SheetClose, { onClick: () => undefined }))
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('title="Close"')
    expect(html).toContain('class="sheet-close overlay-close"')
    expect(html).not.toMatch(/>\s*Close\s*</)
    expect(html).toContain('<svg')
  })

  it('puts that X on the shared header Select and Snap reuse', () => {
    const html = renderToStaticMarkup(createElement(SheetHeader, {
      title: createElement('strong', null, 'Select'),
      onClose: () => undefined,
    }))
    expect(html).toContain('class="sheet-head"')
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('>Select<')
    expect(html).not.toMatch(/>\s*Close\s*</)
    const sheet = renderToStaticMarkup(createElement(ArrangeBottomSheet, {
      id: 'tool-choices',
      label: 'Select',
      title: 'Select',
      onClose: () => undefined,
      children: createElement('button', { type: 'button' }, 'Draw'),
    }))
    expect(sheet).toContain('arrange-sheet-head')
    expect(sheet).toContain('sheet-close')
    expect(sheet).toContain('>Draw<')
    expect(sheet).not.toMatch(/>\s*Close\s*</)
  })
})
