'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase, fetchAll } from '@/lib/supabase'
import DiscussionPanel from '@/components/DiscussionPanel'

export default function DiscussionPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [soOptions, setSoOptions] = useState<string[]>([])
  const [filterSo, setFilterSo] = useState('')

  // Optional deep link: /discussion?so=SO-40823 focuses that order's thread
  useEffect(() => { setFilterSo(new URLSearchParams(window.location.search).get('so') || '') }, [])
  useEffect(() => {
    if (!profile) return
    fetchAll<{ so_number: string | null }>('sales_order_lines', 'so_number').then(rows =>
      setSoOptions([...new Set(rows.map(r => r.so_number).filter(Boolean) as string[])].sort()))
  }, [profile])

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Discussion</h1>
        <p className="text-gray-500 text-sm mb-5">Shared board for warehouse and office. Link a message to a specific SO number, or filter the thread by SO.</p>
        <DiscussionPanel channel="warehouse" me={profile.id} meName={profile.full_name} title="Warehouse discussion"
          soOptions={soOptions} filterSo={filterSo} onFilterChange={setFilterSo} />
      </div>
    </div>
  )
}
