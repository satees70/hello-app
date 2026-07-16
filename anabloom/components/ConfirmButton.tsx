"use client";

export default function ConfirmButton({
  action,
  id,
  message = "Are you sure?",
  label = "Delete",
  className = "text-expense text-xs hover:underline",
  fields,
}: {
  action: (fd: FormData) => Promise<void>;
  id?: string;
  message?: string;
  label?: string;
  className?: string;
  fields?: Record<string, string>;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(message)) e.preventDefault();
      }}
      className="inline"
    >
      {id !== undefined && <input type="hidden" name="id" value={id} />}
      {fields &&
        Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  );
}
