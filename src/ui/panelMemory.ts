/** Open and closed panels for this visit. Switching views does not forget them. */

type PanelKey = 'arrangeBrowser' | 'arrangeTools' | 'hintDismissed' | 'sessionBrowser' | 'sessionDetail' | 'sessionMix'

const memory: Partial<Record<PanelKey, boolean>> = {}

export function panelChoice(key: PanelKey): boolean | undefined {
  return memory[key]
}

export function rememberPanel(key: PanelKey, open: boolean) {
  memory[key] = open
}
