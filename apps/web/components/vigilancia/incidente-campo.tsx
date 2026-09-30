export function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="min-w-0 space-y-1 text-xs font-medium"><span>{label}</span>{children}</label>;
}
