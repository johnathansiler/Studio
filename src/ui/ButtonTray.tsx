import type { HTMLAttributes, ReactNode } from 'react'

/**
 * Recessed tray for a group of related buttons.
 * `equal` is only for a small top-level switcher (Collab / Arrange / Mix):
 * those segments share the row. Every other tray hugs its labels.
 */
export function ButtonTray({
  as: Tag = 'div',
  equal = false,
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'nav'
  equal?: boolean
  children: ReactNode
}) {
  const classes = ['btn-tray', equal ? 'btn-tray-equal' : '', className].filter(Boolean).join(' ')
  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  )
}
