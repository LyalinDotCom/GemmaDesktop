import { useEffect, useRef, useState } from 'react'
import { Camera, RefreshCw, Check, X } from 'lucide-react'
import type { FileAttachment } from '@/types'

interface CameraCaptureModalProps {
  open: boolean
  onClose: () => void
  onConfirm: (attachment: FileAttachment) => void
}

function estimateDataUrlSize(dataUrl: string): number {
  const payload = dataUrl.split(',')[1] ?? ''
  return Math.round((payload.length * 3) / 4)
}

export function CameraCaptureModal({
  open,
  onClose,
  onConfirm,
}: CameraCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open) {
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop()
        }
        streamRef.current = null
      }
      setCapturedDataUrl(null)
      setError(null)
      return
    }

    let cancelled = false

    async function startCamera() {
      setStarting(true)
      setError(null)

      try {
        const permission = await window.gemmaDesktopBridge.media.requestCameraAccess()
        if (!permission.granted) {
          throw new Error(
            permission.status === 'denied'
              ? 'Camera access was denied.'
              : 'Camera access is not available yet.',
          )
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
          },
          audio: false,
        })

        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop()
          }
          return
        }

        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
      } catch (cameraError) {
        setError(
          cameraError instanceof Error
            ? cameraError.message
            : 'Unable to access the camera.',
        )
      } finally {
        setStarting(false)
      }
    }

    void startCamera()

    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) {
    return null
  }

  const handleCapture = () => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setError('Camera is not ready yet.')
      return
    }

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) {
      setError('Unable to capture the current frame.')
      return
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    setCapturedDataUrl(canvas.toDataURL('image/jpeg', 0.92))
  }

  const handleConfirm = () => {
    if (!capturedDataUrl) {
      return
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
    onConfirm({
      kind: 'image',
      name: `camera-${timestamp}.jpg`,
      size: estimateDataUrlSize(capturedDataUrl),
      mediaType: 'image/jpeg',
      dataUrl: capturedDataUrl,
      previewUrl: capturedDataUrl,
      source: 'camera',
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              Camera Capture
            </h2>
            <p className="text-xs text-zinc-400">
              Take a picture, review it, then attach it to your next message.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
            title="Close camera"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-black">
            {capturedDataUrl ? (
              <img
                src={capturedDataUrl}
                alt="Captured preview"
                className="max-h-[60vh] w-full object-contain"
              />
            ) : (
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="max-h-[60vh] w-full object-contain"
              />
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-red-900/70 bg-red-950/60 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-zinc-500">
              {starting
                ? 'Starting camera...'
                : capturedDataUrl
                  ? 'Review the photo before attaching it.'
                  : 'Position the camera, then capture a frame.'}
            </div>

            <div className="flex items-center gap-2">
              {capturedDataUrl ? (
                <>
                  <button
                    onClick={() => setCapturedDataUrl(null)}
                    className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
                  >
                    <RefreshCw size={14} />
                    Retake
                  </button>
                  <button
                    onClick={handleConfirm}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
                  >
                    <Check size={14} />
                    Use Photo
                  </button>
                </>
              ) : (
                <button
                  onClick={handleCapture}
                  disabled={starting}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Camera size={14} />
                  Capture
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
