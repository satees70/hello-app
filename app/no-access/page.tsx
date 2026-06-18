'use client'

export default function NoAccessPage() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="bg-white rounded-2xl shadow-sm border p-10 max-w-md text-center">
        <div className="text-5xl mb-4">🚫</div>
        <h1 className="text-xl font-bold mb-2">No access to this section</h1>
        <p className="text-gray-600 text-sm mb-6">
          Your account doesn&apos;t have permission to view this part of the system.
          If you think you should, please ask Head Office to update your permissions.
        </p>
        <a href="/dashboard" className="inline-block bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
          Back to dashboard
        </a>
      </div>
    </div>
  )
}
