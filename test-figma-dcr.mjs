import { auth } from '@ai-sdk/mcp';

const provider = {
  get redirectUrl() { return 'http://127.0.0.1:3000/api/auth/figma-mcp/callback'; },
  get clientMetadata() {
    return {
      client_name: 'DS AI Guardian',
      redirect_uris: ['http://127.0.0.1:3000/api/auth/figma-mcp/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  async tokens() { return undefined; },
  async saveTokens(t) { console.log('saveTokens called'); },
  async clientInformation() { return undefined; },
  async saveClientInformation(i) { console.log('saveClientInformation:', JSON.stringify(i)); },
  async redirectToAuthorization(url) { console.log('REDIRECT TO:', url.toString()); throw new Error('REDIRECT_STOP'); },
  async saveCodeVerifier(v) { console.log('saveCodeVerifier called'); },
  async codeVerifier() { return ''; },
  async state() { return 'test123'; },
  async validateResourceURL(s, r) { return new URL(r || s.toString()); },
};

try {
  const result = await auth(provider, { serverUrl: new URL('https://mcp.figma.com') });
  console.log('Result:', result);
} catch (e) {
  if (e.message === 'REDIRECT_STOP') {
    console.log('SUCCESS: Got past registration, redirecting to auth');
  } else {
    console.error('Error:', e.message || e);
    console.error('Full error:', e);
  }
}
