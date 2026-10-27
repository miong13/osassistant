import { useEffect, useState } from 'react'
import type { CharacterInfo, CharacterLoadError } from '../../../shared/types'
import type { TabProps } from './SettingsApp'

const EXAMPLE = `{
  "id": "my-buddy",
  "name": "Buddy",
  "persona": "You are Buddy, a calm and witty helper.",
  "greeting": "Hey there! What's up?",
  "tips": ["Tip: Take a short walk every hour."],
  "size": { "width": 140, "height": 140 },
  "states": {
    "idle": "idle.svg",
    "think": "think.gif",
    "talk": { "sheet": "talk.png", "frameWidth": 140,
              "frameHeight": 140, "frames": 6, "fps": 10 }
  }
}`

export function CharactersTab({ settings, update }: TabProps) {
  const [characters, setCharacters] = useState<CharacterInfo[]>([])
  const [errors, setErrors] = useState<CharacterLoadError[]>([])

  const apply = (r: { characters: CharacterInfo[]; errors: CharacterLoadError[] }) => {
    setCharacters(r.characters)
    setErrors(r.errors)
  }

  useEffect(() => {
    void window.api.listCharacters().then(apply)
  }, [])

  return (
    <>
      <h1>Characters</h1>
      <p className="lede">Pick who lives on your desktop. Each character has its own personality and tips.</p>
      <div className="char-grid">
        {characters.map((c) => (
          <div
            key={c.id}
            className={`char-card ${c.id === settings.characterId ? 'active' : ''}`}
            onClick={() => void update({ characterId: c.id })}
          >
            {c.states.idle.type === 'image' ? (
              <img src={c.states.idle.src} alt={c.name} />
            ) : (
              <div style={{ width: 96, height: 96, margin: '0 auto', background: `url("${c.states.idle.src}") 0 0 / ${c.states.idle.frames * 100}% 100% no-repeat` }} />
            )}
            <div className="name">{c.name}</div>
            <div className="muted">{c.builtIn ? 'Built-in' : 'Custom'}</div>
          </div>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Packs that couldn’t load</h3>
          {errors.map((e) => (
            <p key={e.folder} className="error-text" style={{ marginBottom: 0 }}>
              <strong>{e.folder.split(/[\\/]/).pop()}</strong>: {e.message}
            </p>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3 className="grow">Add your own character</h3>
          <button className="btn" onClick={() => void window.api.openCharactersFolder()}>
            Open characters folder
          </button>
          <button className="btn" onClick={async () => apply(await window.api.reloadCharacters())}>
            Reload
          </button>
        </div>
        <p className="muted" style={{ lineHeight: 1.6 }}>
          Create a folder inside the characters folder with a <code>character.json</code> file and your images.
          Images can be animated SVG, GIF, APNG, WebP, or a sprite sheet (frames side by side). Only{' '}
          <code>idle</code> is required. Other states (<code>greet, listen, think, talk, tip, sleep, error</code>)
          fall back to idle when missing.
        </p>
        <pre className="logs" style={{ maxHeight: 'none' }}>{EXAMPLE}</pre>
      </div>
    </>
  )
}
