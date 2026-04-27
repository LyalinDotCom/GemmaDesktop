import { NebulaField } from '@/components/NebulaField'

interface AmbientMoodProps {
  isGenerating: boolean
  enabled: boolean
}

// Ambient companion to the welcome-screen nebula. The same network of
// glowing curves and nodes sits behind the work surface at all times so it
// never appears out of nowhere; while the agent is running we simply
// release the paths and nodes to drift, and they freeze back in place once
// the turn settles.
export function AmbientMood({ isGenerating, enabled }: AmbientMoodProps) {
  if (!enabled) {
    return null
  }
  return (
    <div
      aria-hidden="true"
      className={`nebula-field-ambient-overlay ${
        isGenerating ? 'nebula-field-ambient-overlay-running' : ''
      }`}
    >
      <NebulaField variant="ambient" />
    </div>
  )
}
