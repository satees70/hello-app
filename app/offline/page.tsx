// Shown by the service worker when a page is opened with no connection and nothing cached.
export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8 text-center bg-gray-50">
      <div>
        <div className="text-4xl mb-3">📶</div>
        <h1 className="text-xl font-semibold text-gray-800">You’re offline</h1>
        <p className="text-gray-500 mt-2 text-sm max-w-xs mx-auto">This screen isn’t available without a connection. Reconnect and it will load automatically.</p>
      </div>
    </div>
  )
}
