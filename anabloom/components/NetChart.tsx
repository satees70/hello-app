"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function NetChart({ data }: { data: { month: string; net: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#6B7A72" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "#6B7A72" }} axisLine={false} tickLine={false} width={48} />
        <Tooltip
          formatter={(v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #E4E7E3" }}
        />
        <Bar dataKey="net" radius={[3, 3, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.net >= 0 ? "#2E5E4E" : "#B5443C"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
