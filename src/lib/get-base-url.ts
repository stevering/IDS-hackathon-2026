import { headers } from 'next/headers';

export async function getBaseUrl(): Promise<string> {
  // 1. Client-side → toujours le vrai domaine de l’iframe
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  // 2. Server-side (API routes, server actions, getServerSideProps…)
  const headersList = await headers();
  const host = 
    headersList.get('x-forwarded-host') || 
    headersList.get('host') || 
    'preview.guardian.figdesys.com';   // fallback ultra-safe pour ton custom domain

  const protocol = process.env.NODE_ENV === 'development' ? 'http:' : 'https:';
  return `${protocol}//${host}`;
}