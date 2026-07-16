"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const COLORS = ["#2E5E4E", "#5B8C7B", "#C98A3C", "#B5443C", "#3C6E9C", "#8C6BB1"];

export default function GroupNetChart({ data, companies }: { data: Record<string, number | string>[]; companies: string[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#EEF0ED" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6B7A72" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "#6B7A72" }} axisLine={false} tickLine={false} width={52} />
        <Tooltip
          formatter={(v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #E4E7E3" }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {companies.map((c, i) => (
          <Bar key={c} dataKey={c} fill={COLORS[i % COLORS.length]} radius={[2, 2, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
