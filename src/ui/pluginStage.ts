/** Line the panel Close pill up with the transport Menu, on the right. */
export function alignPluginClose(shell: HTMLElement | null) {
  if (!shell) return
  const plugin = shell.getAttribute('data-plugin')
  if (plugin !== 'steps' && plugin !== 'pads') return
  const menu = shell.querySelector('.transport .t-btn.menu')
  const close = shell.querySelector(plugin === 'steps' ? '.step-close' : '.mpc-close') as HTMLElement | null
  const bar = close?.parentElement
  if (!menu || !close || !bar) return
  const menuBox = menu.getBoundingClientRect()
  const barBox = bar.getBoundingClientRect()
  close.style.right = `${Math.round(barBox.right - menuBox.right)}px`
}
