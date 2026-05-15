"use client";

// Tiny [value, setter] pair backed by a URL search param. Mirrors the React
// useState shape so it can replace useState/localStorage call sites without
// changing the surrounding code.
//
// - `revalidateOnFocus`-style burst fetches don't apply here: we only touch
//   the URL via router.replace, which is cheap and idempotent.
// - The default value is removed from the URL when set (keeps URLs clean).

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";

export function useUrlState(
  key: string,
  defaultValue: string | null = null,
): [string | null, (next: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const value = search.get(key) ?? defaultValue;

  const setValue = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(search.toString());
      if (next === null || next === defaultValue) {
        params.delete(key);
      } else {
        params.set(key, next);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, search, key, defaultValue],
  );

  return [value, setValue];
}
