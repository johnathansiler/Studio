import type { VaryAmount } from '../ideas/types'
import type { ProjectStore } from '../state/store'

const AMOUNTS: { id: VaryAmount; name: string }[] = [
  { id: 'subtle', name: 'Subtle' },
  { id: 'medium', name: 'Medium' },
  { id: 'bold', name: 'Bold' },
]

/** Amount, Variation, and Re-roll for the clip selected on Arrange. */
export function VariationBar({ store }: { store: ProjectStore }) {
  const amount = store.varyAmount
  void store.version
  return (
    <div className="variation-dock" data-variation="dock" role="group" aria-label="Variation">
      {AMOUNTS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={amount === item.id ? 'on' : ''}
          aria-pressed={amount === item.id}
          onClick={() => store.setVaryAmount(item.id)}
        >
          {item.name}
        </button>
      ))}
      <button type="button" data-variation="make" onClick={() => store.varyArrangeClip()}>Variation</button>
      <button type="button" data-variation="reroll" onClick={() => store.varyArrangeClip({ reroll: true })}>Re-roll</button>
    </div>
  )
}
