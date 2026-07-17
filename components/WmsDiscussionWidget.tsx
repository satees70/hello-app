'use client'
import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import DiscussionPanel from '@/components/DiscussionPanel'

// A floating "💬 Discussion" button on EVERY WMS page. It offers BOTH:
//   • a shared WMS channel (everyone with warehouse access) — the current page is the
//     default thread, so the office can see which area a question is about, and
//   • private groups (only members can read/post), created & managed right here.
// Reuses the same DiscussionPanel / discussions table / mentions / attachments as the
// main portal chat. No schema change — 'wms' and 'group:*' channels are already handled
// by the existing discussions RLS.

const PAGE_LABELS: Record<string, string> = {
  '/wms': 'WMS Home',
  '/wms/locations': 'Location Map',
  '/wms/stock': 'Stock',
  '/wms/purchase-orders': 'Purchase Orders',
  '/wms/suppliers': 'Suppliers',
  '/wms/putaway': 'Putaway',
  '/wms/transfers': 'Transfers',
  '/wms/orders': 'Orders to Pick',
  '/wms/dispatch': 'Delivery Orders',
  '/wms/counts': 'Stock Counts',
  '/wms/approvals': 'Approvals',
  '/wms/reports/expiry': 'Expiry',
  '/wms/reports/stock-card': 'Stock Card',
  '/wms/reports': 'Reports',
  '/wms/labels': 'Labels',
  '/wms/movements': 'Movements',
}
function pageLabel(path: string): string {
  if (PAGE_LABELS[path]) return PAGE_LABELS[path]
  const hit = Object.keys(PAGE_LABELS).filter(p => p !== '/wms' && path.startsWith(p)).sort((a, b) => b.length - a.length)[0]
  if (hit) return PAGE_LABELS[hit]
  const seg = path.split('/').filter(Boolean).pop() || 'WMS'
  return seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

interface Group { id: string; name: string; created_by: string | null; created_by_name: string | null }
const LAST_KEY = 'wms_disc_lastopen'

export default function WmsDiscussionWidget() {
  const { profile } = useProfile()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)

  // Channels: 'wms' (shared) or a private group id.
  const [sel, setSel] = useState('wms')
  const [groups, setGroups] = useState<Group[]>([])
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')
  // Manage-members modal
  const [manageFor, setManageFor] = useState<Group | null>(null)
  const [members, setMembers] = useState<string[]>([])
  const [addPick, setAddPick] = useState('')
  const [selMembers, setSelMembers] = useState<string[]>([])   // members of the open group, for tag-restriction

  const countUnread = useCallback(async () => {
    if (!profile) return
    let since: string | null = null
    try { since = localStorage.getItem(LAST_KEY) } catch { /* ignore */ }
    const base = () => {
      let q = supabase.from('discussions').select('id', { count: 'exact', head: true }).neq('author_id', profile.id)
      if (since) q = q.gt('created_at', since)
      return q
    }
    // RLS keeps group rows to groups this user belongs to.
    const [a, b] = await Promise.all([base().eq('channel', 'wms'), base().like('channel', 'group:%')])
    setUnread((a.count || 0) + (b.count || 0))
  }, [profile])

  const loadGroups = useCallback(async () => {
    const { data } = await supabase.from('discussion_groups').select('id, name, created_by, created_by_name').order('created_at')
    setGroups((data as Group[]) || [])
  }, [])

  useEffect(() => {
    if (!profile || open) return
    countUnread()
    const t = setInterval(countUnread, 30000)
    return () => clearInterval(t)
  }, [profile, open, countUnread])

  // Load groups + the user directory once the panel is opened.
  useEffect(() => {
    if (!open || !profile) return
    loadGroups()
    supabase.rpc('list_users').then(({ data }) => setUsers((data as { id: string; full_name: string }[]) || []))
  }, [open, profile, loadGroups])

  // Members of the selected group (so only they can be @tagged).
  useEffect(() => {
    const g = groups.find(x => x.id === sel)
    if (!g) { setSelMembers([]); return }
    supabase.from('discussion_group_members').select('user_id').eq('group_id', g.id).then(({ data }) => setSelMembers((data || []).map(r => r.user_id)))
  }, [sel, groups])

  if (!profile) return null

  const nameOf = (id: string) => users.find(u => u.id === id)?.full_name || 'someone'
  const isManager = (g: Group) => g.created_by === profile.id || profile.role === 'admin' || profile.factory_code === 'HEAD_OFFICE'
  const selGroup = sel === 'wms' ? null : (groups.find(g => g.id === sel) || null)
  const channel = selGroup ? `group:${selGroup.id}` : 'wms'
  const title = selGroup ? `🔒 ${selGroup.name}` : 'WMS Discussion'

  function toggle() {
    const nowOpen = !open
    setOpen(nowOpen)
    if (nowOpen) { try { localStorage.setItem(LAST_KEY, new Date().toISOString()) } catch { /* ignore */ } ; setUnread(0) }
    else countUnread()
  }

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
    if (manageFor.id === sel) setSelMembers(m => [...new Set([...m, uid])])
  }
  async function removeMember(uid: string) {
    if (!manageFor) return
    const { error } = await supabase.rpc('remove_group_member', { p_group: manageFor.id, p_user: uid })
    if (error) { setErr(error.message); return }
    setMembers(m => m.filter(x => x !== uid))
    if (manageFor.id === sel) setSelMembers(m => m.filter(x => x !== uid))
  }
  async function deleteGroup(g: Group) {
    if (!confirm(`Delete the group “${g.name}” and all its messages? This can't be undone.`)) return
    const { error } = await supabase.rpc('delete_discussion_group', { p_group: g.id })
    if (error) { setErr(error.message); return }
    setManageFor(null); setSel('wms'); await loadGroups()
  }

  return (
    <>
      {!open && (
        <button onClick={toggle} title="Ask a question / discuss"
          className="fixed z-40 bottom-4 right-4 flex items-center gap-2 bg-emerald-700 text-white rounded-full shadow-lg px-4 py-3 hover:bg-emerald-800">
          <span className="text-lg leading-none">💬</span>
          <span className="text-sm font-medium hidden sm:inline">Discussion</span>
          {unread > 0 && <span className="inline-flex items-center justify-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-red-500 text-white text-[11px] font-bold leading-none">{unread}</span>}
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4" onClick={() => toggle()}>
          <div className="bg-white w-full sm:max-w-4xl sm:rounded-xl shadow-lg max-h-[94vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b bg-emerald-700 text-white">
              <span className="font-semibold text-sm">{selGroup ? `🔒 ${selGroup.name}` : <>WMS Discussion <span className="font-normal text-emerald-200">· asking from {pageLabel(pathname)}</span></>}</span>
              <button onClick={() => toggle()} className="text-emerald-100 hover:text-white text-lg leading-none">✕</button>
            </div>

            {/* Channel selector: shared WMS + private groups */}
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b bg-gray-50">
              <button onClick={() => setSel('wms')} className={`px-2.5 py-1 rounded-lg text-sm border ${sel === 'wms' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white hover:bg-gray-100'}`}>🏢 WMS (shared)</button>
              {groups.map(g => (
                <button key={g.id} onClick={() => setSel(g.id)} className={`px-2.5 py-1 rounded-lg text-sm border ${sel === g.id ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white hover:bg-gray-100'}`}>🔒 {g.name}</button>
              ))}
              <div className="flex items-center gap-1 ml-auto">
                <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') createGroup() }} placeholder="New private group…" className="border rounded-lg px-2 py-1 text-sm w-36" />
                <button onClick={createGroup} disabled={creating || !newName.trim()} className="bg-gray-800 text-white px-2.5 py-1 rounded-lg text-sm disabled:opacity-50">＋</button>
              </div>
            </div>

            {selGroup && (
              <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-gray-500 border-b bg-gray-50">
                <span>Private group · only members can see it · by {selGroup.created_by_name || '—'}</span>
                {isManager(selGroup) && <button onClick={() => openManage(selGroup)} className="text-emerald-600 hover:underline">👥 Members</button>}
                {isManager(selGroup) && <button onClick={() => deleteGroup(selGroup)} className="text-red-600 hover:underline">🗑 Delete</button>}
              </div>
            )}
            {err && <p className="text-red-500 text-xs px-3 py-1.5 border-b">{err}</p>}

            <div className="overflow-y-auto p-3">
              <DiscussionPanel key={channel} channel={channel} me={profile.id} meName={profile.full_name} title={title}
                filterTopic={selGroup ? undefined : pageLabel(pathname)}
                restrictToUserIds={selGroup ? selMembers : undefined} />
            </div>
          </div>
        </div>
      )}

      {manageFor && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setManageFor(null)}>
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
              <button onClick={() => addMember(addPick)} disabled={!addPick} className="bg-emerald-600 text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50">Add</button>
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
    </>
  )
}
