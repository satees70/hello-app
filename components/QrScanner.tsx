'use client'
import { useEffect, useRef } from 'react'
import jsQR from 'jsqr'

// Live camera QR reader. Calls onDetect with the decoded text (throttled so the
// same code doesn't fire repeatedly). Uses the back camera on phones/tablets.
export default function QrScanner({ onDetect, onError }: { onDetect: (value: string) => void; onError?: (msg: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const detectRef = useRef(onDetect); detectRef.current = onDetect
  const errRef = useRef(onError); errRef.current = onError

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let cancelled = false
    const last = { v: '', t: 0 }
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    function loop() {
      const v = videoRef.current
      if (v && v.readyState === v.HAVE_ENOUGH_DATA && ctx) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
        if (code && code.data) {
          const now = Date.now()
          if (code.data !== last.v || now - last.t > 1500) { last.v = code.data; last.t = now; detectRef.current(code.data) }
        }
      }
      if (!cancelled) raf = requestAnimationFrame(loop)
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        const v = videoRef.current!; v.srcObject = stream; await v.play(); loop()
      } catch (e) { errRef.current?.(e instanceof Error ? e.message : 'Camera not available') }
    })()

    return () => { cancelled = true; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach(t => t.stop()) }
  }, [])

  return <video ref={videoRef} playsInline muted className="w-full rounded-lg bg-black aspect-square object-cover" />
}
