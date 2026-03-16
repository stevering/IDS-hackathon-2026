import { AppHeader } from "@/components/AppHeader";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen">
      <AppHeader />
      <div className="relative">{children}</div>
    </div>
  );
}
