import type { OAuthClientProvider, OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { RedirectError, getBaseUrl } from "./figma-mcp-oauth";

const SOUTHLEFT_MCP_URL = "https://figma-console-mcp.southleft.com";

const COOKIE_TOKENS = "southleft_mcp_tokens";
const COOKIE_CLIENT_INFO = "southleft_mcp_client_info";
const COOKIE_CODE_VERIFIER = "southleft_mcp_code_verifier";
const COOKIE_STATE = "southleft_mcp_state";

export function getSouthleftRedirectUrl(): string {
  return `${getBaseUrl()}/api/auth/southleft-mcp/callback`;
}

export function createSouthleftMcpOAuthProvider(
  cookieStore: ReadonlyRequestCookies,
  setCookies?: (name: string, value: string, options: Record<string, unknown>) => void,
  forceState?: string,
): OAuthClientProvider {
  const isSecure = getBaseUrl().startsWith("https");

  const cookieOptions = {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    path: "/",
  };

  return {
    get redirectUrl() {
      return getSouthleftRedirectUrl();
    },

    get clientMetadata() {
      return {
        client_name: "DS AI Guardian",
        redirect_uris: [getSouthleftRedirectUrl()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const raw = cookieStore.get(COOKIE_TOKENS)?.value;
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as OAuthTokens;
      } catch {
        return undefined;
      }
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      setCookies?.(COOKIE_TOKENS, JSON.stringify(tokens), {
        ...cookieOptions,
        maxAge: 7776000,
      });
    },

    async clientInformation(): Promise<OAuthClientInformation | undefined> {
      const raw = cookieStore.get(COOKIE_CLIENT_INFO)?.value;
      if (raw) {
        try {
          return JSON.parse(raw) as OAuthClientInformation;
        } catch {
          // ignore
        }
      }
      return undefined;
    },

    async saveClientInformation(info: OAuthClientInformation): Promise<void> {
      setCookies?.(COOKIE_CLIENT_INFO, JSON.stringify(info), {
        ...cookieOptions,
        maxAge: 365 * 24 * 3600,
      });
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      throw new RedirectError(authorizationUrl.toString());
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      setCookies?.(COOKIE_CODE_VERIFIER, codeVerifier, {
        ...cookieOptions,
        maxAge: 600,
      });
    },

    async codeVerifier(): Promise<string> {
      return cookieStore.get(COOKIE_CODE_VERIFIER)?.value || "";
    },

    async state(): Promise<string> {
      if (forceState) return forceState;
      const raw = cookieStore.get(COOKIE_STATE)?.value;
      return raw || "";
    },

    async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
      const sUrl = serverUrl.toString();
      const rUrl = resource || sUrl;
      if (sUrl.includes("southleft.com") || rUrl.includes("southleft.com")) {
        return new URL(rUrl);
      }
      return undefined;
    },
  };
}

export function hasSouthleftTokens(cookieStore: ReadonlyRequestCookies): boolean {
  return !!cookieStore.get(COOKIE_TOKENS)?.value;
}

export { SOUTHLEFT_MCP_URL, COOKIE_TOKENS as SOUTHLEFT_COOKIE_TOKENS, COOKIE_CLIENT_INFO as SOUTHLEFT_COOKIE_CLIENT_INFO, COOKIE_CODE_VERIFIER as SOUTHLEFT_COOKIE_CODE_VERIFIER, COOKIE_STATE as SOUTHLEFT_COOKIE_STATE };
