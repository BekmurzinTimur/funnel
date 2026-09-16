import { useCallback, useState } from 'react';

// The admin bearer token (SPEC §5). Kept in sessionStorage so it survives a
// reload of this tab and nothing more.

const TOKEN_KEY = 'funnel-admin-token';

function readStoredToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the token lives for this page view only.
  }
}

export interface AdminToken {
  token: string;
  setToken: (next: string) => void;
  clearToken: () => void;
}

export function useAdminToken(): AdminToken {
  const [token, setTokenState] = useState(readStoredToken);

  const setToken = useCallback((next: string) => {
    const trimmed = next.trim();
    storeToken(trimmed);
    setTokenState(trimmed);
  }, []);

  const clearToken = useCallback(() => {
    storeToken('');
    setTokenState('');
  }, []);

  return { token, setToken, clearToken };
}
