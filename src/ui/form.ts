import { useEffect, useState } from 'react'

export type FormFactor = 'phone' | 'fold' | 'desk'
export type PointerKind = 'fine' | 'coarse'

/** Phone shell for touch and narrow windows, including the Fold inner screen. */
export const PHONE_SHELL_MAX = 1024
/** A coarse pointer keeps the phone shell through Fold landscape (~1104). */
export const TOUCH_SHELL_MAX = 1199

export function readPointer(): PointerKind {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'fine'
  try {
    if (window.matchMedia('(any-pointer: coarse)').matches || window.matchMedia('(pointer: coarse)').matches) return 'coarse'
  } catch { /* matchMedia can throw in locked-down test stubs */ }
  return 'fine'
}

/**
 * Phone shell through 1024px, and through Fold landscape when the pointer is coarse.
 * A fine pointer from 1025px to 1100px keeps the fold shell. Desktop stays a fine
 * pointer wider than 1100px (the >=1200 desktop window included).
 */
export function formFactor(width: number, height: number, pointer: PointerKind = 'fine'): FormFactor {
  const landscape = width > height
  if (landscape && height <= 520) return 'phone'
  if (width <= PHONE_SHELL_MAX) return 'phone'
  if (pointer === 'coarse' && width <= TOUCH_SHELL_MAX) return 'phone'
  if (width <= 1100) return 'fold'
  return 'desk'
}

export function useLandscape(): boolean {
  const [value, setValue] = useState(() => typeof window !== 'undefined' && window.innerWidth > window.innerHeight)
  useEffect(() => {
    const apply = () => setValue(window.innerWidth > window.innerHeight)
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  return value
}

export function useFormFactor(): FormFactor {
  const read = () => formFactor(window.innerWidth, window.innerHeight, readPointer())
  const [value, setValue] = useState<FormFactor>(() =>
    typeof window === 'undefined' ? 'desk' : read(),
  )
  useEffect(() => {
    const apply = () => setValue(read())
    apply()
    window.addEventListener('resize', apply)
    const medias = ['(any-pointer: coarse)', '(pointer: coarse)']
      .filter(() => typeof window.matchMedia === 'function')
      .map((query) => window.matchMedia(query))
    for (const media of medias) media.addEventListener('change', apply)
    return () => {
      window.removeEventListener('resize', apply)
      for (const media of medias) media.removeEventListener('change', apply)
    }
  }, [])
  return value
}
