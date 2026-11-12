import { useRef, useState } from 'react'

export function FavoriteStar({
  name,
  pressed,
  onToggle,
}: {
  name: string
  pressed: boolean
  onToggle: () => void
}) {
  const timer = useRef(0)
  const [menu, setMenu] = useState(false)
  function cancel() {
    window.clearTimeout(timer.current)
  }
  return (
    <span className="favorite-star-wrap">
      <button
        type="button"
        className={`favorite-star${pressed ? ' on' : ''}`}
        aria-pressed={pressed}
        aria-label={pressed ? `Unfavorite ${name}` : `Favorite ${name}`}
        title={pressed ? 'Remove from favorites.' : 'Save to favorites on this device.'}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu(true)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          cancel()
          timer.current = window.setTimeout(() => setMenu(true), 450)
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
      >
        <Star filled={pressed} />
      </button>
      {menu && (
        <button
          type="button"
          className="favorite-menu"
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
            setMenu(false)
          }}
        >
          {pressed ? 'Remove favorite' : 'Favorite'}
        </button>
      )}
    </span>
  )
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg className="favorite-star-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 3.2l2.4 5.1 5.6.7-4.1 3.8 1.1 5.5L12 15.8 7 18.3l1.1-5.5L4 9l5.6-.7L12 3.2z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}
