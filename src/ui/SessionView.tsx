import type { ProjectStore } from '../state/store'

export function SessionView({ store }: { store: ProjectStore }) {
  const scenes = 8
  return (
    <div className="session-grid">
      <p className="hint">Launch a clip and it loops from the next beat. Arrangement playback stays put until you press play there again.</p>
      <table>
        <thead>
          <tr>
            <th />
            {store.project.tracks.map((track) => (
              <th key={track.id} style={{ color: track.color }}>
                {track.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: scenes }, (_, scene) => (
            <tr key={scene}>
              <th>{scene + 1}</th>
              {store.project.tracks.map((track) => {
                const clip = track.type === 'audio' ? track.clips[scene] : track.midiClips[scene]
                const launched = clip && store.launched[track.id] === clip.id
                return (
                  <td key={track.id}>
                    <button
                      className={`slot ${clip ? 'filled' : ''} ${launched ? 'live' : ''}`}
                      style={clip ? { background: track.color } : undefined}
                      onClick={() => {
                        if (!clip) return
                        store.launch(track.id, launched ? null : clip.id)
                      }}
                    >
                      {clip ? clip.name : 'empty'}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <button className="text-btn" onClick={() => store.stopSession()}>
        Stop clips
      </button>
    </div>
  )
}
