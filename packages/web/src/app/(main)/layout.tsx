import { AppHeader } from "@/components/AppHeader";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen">
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div className="wave-bg-layer wave-bg-1" />
        <div className="wave-bg-layer wave-bg-2" />
        <div className="wave-bg-layer wave-bg-3" />
        <div className="wave-bg-noise" />
        <div className="aurora aurora-1" />
        <div className="aurora aurora-2" />
        <div className="aurora aurora-3" />
        <div className="aurora aurora-4" />
        <div className="aurora aurora-5" />
      </div>
      <AppHeader />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
