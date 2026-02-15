import type { OAuthClientProvider, OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { RedirectError, getBaseUrl } from "./figma-mcp-oauth";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp";

const COOKIE_TOKENS = "github_mcp_tokens";
const COOKIE_CLIENT_INFO = "github_mcp_client_info";
const COOKIE_CODE_VERIFIER = "github_mcp_code_verifier";
const COOKIE_STATE = "github_mcp_state";

export function getGithubRedirectUrl(): string {
  return `${getBaseUrl()}/api/auth/github-mcp/callback`;
}

export function createGithubMcpOAuthProvider(
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
      return getGithubRedirectUrl();
        },

    get clientMetadata() {
      return {
        client_name: "DS AI Guardian",
        redirect_uris: [getGithubRedirectUrl()],
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

      if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
        return {
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
        };
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
      if (sUrl.includes("github.com") || sUrl.includes("githubcopilot.com") || rUrl.includes("github.com") || rUrl.includes("githubcopilot.com")) {
        return new URL(rUrl);
      }
      return undefined;
    },
  };
}

export function hasGithubTokens(cookieStore: ReadonlyRequestCookies): boolean {
  return !!cookieStore.get(COOKIE_TOKENS)?.value;
}

export { 
  GITHUB_MCP_URL, 
  COOKIE_TOKENS as GITHUB_COOKIE_TOKENS, 
  COOKIE_CLIENT_INFO as GITHUB_COOKIE_CLIENT_INFO, 
  COOKIE_CODE_VERIFIER as GITHUB_COOKIE_CODE_VERIFIER, 
  COOKIE_STATE as GITHUB_COOKIE_STATE 
};