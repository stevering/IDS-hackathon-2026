import { redirect } from "next/navigation";

// Server-side redirect from "/" to "/chat". Replaces the previous client-side
// re-export pattern, which caused Home to mount once on "/" then unmount and
// remount on "/chat/<id>". Keeping this as a Server Component means there is
// no React tree at "/" — the browser is redirected before any client code runs.
export default function RootPage() {
  redirect("/chat");
}
