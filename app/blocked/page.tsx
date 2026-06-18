'use client'

export default function BlockedPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="bg-white rounded-2xl shadow-sm border p-10 max-w-md text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="text-xl font-bold mb-2">Office access only</h1>
        <p className="text-gray-600 text-sm mb-6">
          This system can only be used from a factory office network. You appear to be connecting from
          somewhere else (for example home Wi-Fi or mobile data).
          <br /><br />
          Please connect to the office Wi-Fi and try again, or contact Head Office if you believe this is a mistake.
        </p>
        <a href="/login" className="inline-block bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
          Back to login
        </a>
      </div>
    </div>
  )
}
