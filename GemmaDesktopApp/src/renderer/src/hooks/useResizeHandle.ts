import { useCallback, useEffect, useRef, useState } from 'react'

interface UseResizeHandleOptions {
  /** Initial width in pixels. */
  initialWidth: number
  /** Minimum allowed width. */
  minWidth: number
  /** Maximum allowed width. */
  maxWidth: number
  /**
   * Direction the drag should move:
   * - 'right' means dragging rightward increases the width (sidebar right edge).
   * - 'left' means dragging leftward increases the width (right-dock left edge).
   */
  direction: 'left' | 'right'
}

export function useResizeHandle({
  initialWidth,
  minWidth,
  maxWidth,
  direction,
}: UseResizeHandleOptions) {
  const [width, setWidth] = useState(initialWidth)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      dragging.current = true
      startX.current = event.clientX
      startWidth.current = width
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    },
    [width],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging.current) {
        return
      }

      const delta = event.clientX - startX.current
      const nextWidth =
        direction === 'right'
          ? startWidth.current + delta
          : startWidth.current - delta

      setWidth(Math.max(minWidth, Math.min(maxWidth, nextWidth)))
    },
    [direction, maxWidth, minWidth],
  )

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const setClampedWidth = useCallback(
    (nextWidth: number) => {
      setWidth(Math.max(minWidth, Math.min(maxWidth, nextWidth)))
    },
    [maxWidth, minWidth],
  )

  // Reset to initial width if it changes (e.g. sidebar toggle)
  useEffect(() => {
    setWidth(initialWidth)
  }, [initialWidth])

  return {
    width,
    setWidth: setClampedWidth,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
    isDragging: dragging.current,
  }
}
