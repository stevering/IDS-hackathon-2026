import { headers } from 'next/headers';

export async function getBaseUrl(): Promise<string> {
  // 1. Client-side → always use the real iframe domain
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  // 2. Server-side: prefer NEXT_PUBLIC_BASE_URL to ensure the redirect_uri
  //    matches the canonical domain registered in OAuth providers (e.g. Figma
  //    requires 127.0.0.1 — not localhost).
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, '');
  }

  // 3. Fallback: derive from request headers
  const headersList = await headers();
  const host =
    headersList.get('x-forwarded-host') ||
    headersList.get('host') ||
    'preview.guardian.figdesys.com';   // ultra-safe fallback for custom domain

  const protocol = process.env.NODE_ENV === 'development' ? 'http:' : 'https:';
  return `${protocol}//${host}`;
}