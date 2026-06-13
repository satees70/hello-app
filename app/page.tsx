import { supabase } from '@/lib/supabase'

export default async function Home() {
  const { data, error } = await supabase.from('messages').select('*')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">Hello, World!</h1>
      <p className="text-gray-500">Connected to Supabase</p>
      {error && <p className="text-red-500">No messages table yet — that is okay!</p>}
      {data && data.length > 0 && (
        <ul>
          {data.map((msg: { id: number; text: string }) => (
            <li key={msg.id}>{msg.text}</li>
          ))}
        </ul>
      )}
    </main>
  )
}
