// Polling that pauses while the tab/app is in the background. Phones keep PWAs alive in
// the background for a long time, and every hidden tick is wasted battery + Supabase
// queries. Ticks are skipped while `document.hidden`; when the page becomes visible
// again `fn` runs once straight away so the screen is fresh. Returns a cleanup function,
// so it drops into an effect in place of setInterval/clearInterval:
//   useEffect(() => { load(); return visibleInterval(load, 30000) }, [load])
export function visibleInterval(fn: () => unknown, ms: number): () => void {
  const tick = () => { if (typeof document === 'undefined' || !document.hidden) fn() }
  const onVis = () => { if (!document.hidden) fn() }
  const timer = setInterval(tick, ms)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  return () => {
    clearInterval(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
  }
}
