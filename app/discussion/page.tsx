'use client'
import { useCallback, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase, fetchAll } from '@/lib/supabase'
import DiscussionPanel from '@/components/DiscussionPanel'

interface Group { id: string; name: string; created_by: string | null; created_by_name: string | null }

export default function DiscussionPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [soOptions, setSoOptions] = useState<string[]>([])
  const [filterSo, setFilterSo] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [sel, setSel] = useState('warehouse')   // 'warehouse' or a group id
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [manageFor, setManageFor] = useState<Group | null>(null)
  const [members, setMembers] = useState<string[]>([])   // user ids in the group being managed
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([])
  const [addPick, setAddPick] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { setFilterSo(new URLSearchParams(window.location.search).get('so') || '') }, [])
  useEffect(() => {
    if (!profile) return
    fetchAll<{ so_number: string | null }>('sales_order_lines', 'so_number').then(rows =>
      setSoOptions([...new Set(rows.map(r => r.so_number).filter(Boolean) as string[])].sort()))
    supabase.rpc('list_users').then(({ data }) => setUsers((data as { id: string; full_name: string }[]) || []))
    loadGroups()
  }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadGroups = useCallback(async () => {
    const { data } = await supabase.from('discussion_groups').select('id, name, created_by, created_by_name').order('created_at')
    setGroups((data as Group[]) || [])
  }, [])

  const nameOf = (id: string) => users.find(u => u.id === id)?.full_name || 'someone'
  const isManager = (g: Group) => !!profile && (g.created_by === profile.id || profile.role === 'admin' || profile.factory_code === 'HEAD_OFFICE')

  async function createGroup() {
    const n = newName.trim(); if (!n) return
    setCreating(true); setErr('')
    const { data, error } = await supabase.rpc('create_discussion_group', { p_name: n })
    setCreating(false)
    if (error) { setErr(error.message); return }
    setNewName(''); await loadGroups(); setSel(data as string)
  }
  async function openManage(g: Group) {
    setManageFor(g); setErr(''); setAddPick('')
    const { data } = await supabase.from('discussion_group_members').select('user_id').eq('group_id', g.id)
    setMembers((data || []).map(r => r.user_id))
  }
  async function addMember(uid: string) {
    if (!manageFor || !uid) return
    const { error } = await supabase.rpc('add_group_member', { p_group: manageFor.id, p_user: uid })
    if (error) { setErr(error.message); return }
    setMembers(m => [...new Set([...m, uid])]); setAddPick('')
  }
  async function removeMember(uid: string) {
    if (!manageFor) return
    const { error } = await supabase.rpc('remove_group_member', { p_group: manageFor.id, p_user: uid })
    if (error) { setErr(error.message); return }
    setMembers(m => m.filter(x => x !== uid))
  }
  async function deleteGroup(g: Group) {
    if (!confirm(`Delete the group “${g.name}” and all its messages? This can't be undone.`)) return
    const { error } = await supabase.rpc('delete_discussion_group', { p_group: g.id })
    if (error) { setErr(error.message); return }
    setManageFor(null); setSel('warehouse'); await loadGroups()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const selGroup = groups.find(g => g.id === sel) || null
  const channel = selGroup ? `group:${selGroup.id}` : 'warehouse'
  const title = selGroup ? `🔒 ${selGroup.name}` : 'Warehouse discussion'

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Discussion</h1>
        <p className="text-gray-500 text-sm mb-4">One conversation per order. Pick an order to open its chat — unread messages are marked with a red count. Groups are private — only members can see them.</p>

        {/* Channel selector */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button onClick={() => setSel('warehouse')} className={`px-3 py-1.5 rounded-lg text-sm border ${sel === 'warehouse' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-gray-50'}`}>🏢 Warehouse</button>
          {groups.map(g => (
            <button key={g.id} onClick={() => setSel(g.id)} className={`px-3 py-1.5 rounded-lg text-sm border ${sel === g.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-gray-50'}`}>🔒 {g.name}</button>
          ))}
          <div className="flex items-center gap-1">
            <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') createGroup() }} placeholder="New group name…" className="border rounded-lg px-2 py-1.5 text-sm w-40" />
            <button onClick={createGroup} disabled={creating || !newName.trim()} className="bg-gray-800 text-white px-3 py-1.5 rounded-lg text-sm disabled:opacity-50">＋ Create</button>
          </div>
        </div>
        {err && <p className="text-red-500 text-sm mb-3">{err}</p>}

        {selGroup && (
          <div className="flex items-center gap-3 mb-3 text-sm text-gray-500">
            <span>Private group · created by {selGroup.created_by_name || '—'}</span>
            {isManager(selGroup) && <button onClick={() => openManage(selGroup)} className="text-blue-600 hover:underline">👥 Manage members</button>}
            {isManager(selGroup) && <button onClick={() => deleteGroup(selGroup)} className="text-red-600 hover:underline">🗑 Delete group</button>}
          </div>
        )}

        <DiscussionPanel key={channel} channel={channel} me={profile.id} meName={profile.full_name} title={title}
          soOptions={soOptions} filterSo={selGroup ? '' : filterSo} onFilterChange={selGroup ? undefined : setFilterSo} />
      </div>

      {manageFor && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setManageFor(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-10 p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-lg">👥 {manageFor.name} — members</h3>
              <button onClick={() => setManageFor(null)} className="text-gray-400 hover:text-gray-600 text-sm">Close</button>
            </div>
            <p className="text-sm text-gray-500 mb-3">Only members can see and post in this group.</p>
            <div className="flex gap-2 mb-3">
              <select value={addPick} onChange={e => setAddPick(e.target.value)} className="flex-1 border rounded-lg px-2 py-2 text-sm">
                <option value="">Add a person…</option>
                {users.filter(u => !members.includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
              <button onClick={() => addMember(addPick)} disabled={!addPick} className="bg-blue-600 text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50">Add</button>
            </div>
            <ul className="space-y-1 max-h-72 overflow-auto">
              {members.length === 0 && <li className="text-sm text-gray-400">No members yet.</li>}
              {members.map(uid => (
                <li key={uid} className="flex items-center justify-between gap-2 text-sm border-b border-gray-100 py-1.5">
                  <span>{nameOf(uid)}{uid === manageFor.created_by && <span className="text-gray-400 text-xs ml-1">· owner</span>}</span>
                  {uid !== manageFor.created_by && <button onClick={() => removeMember(uid)} className="text-red-500 hover:underline text-xs">Remove</button>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
