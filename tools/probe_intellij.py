import requests
import json

# Standard port for IntelliJ's embedded server
INTELLIJ_PORT = 63342
MCP_BASE_URL = f"http://127.0.0.1:{INTELLIJ_PORT}"

# We'll test the standard suspected endpoints for MCP in IntelliJ
# Often /mcp or /api/mcp or via a specific transport
endpoints = ["/mcp", "/sse", "/api/mcp"]

def probe_intellij_mcp():
    print(f"--- Searching for MCP server on IntelliJ (port {INTELLIJ_PORT}) ---")
    session = requests.Session()
    
    for ep in endpoints:
        url = f"{MCP_BASE_URL}{ep}"
        print(f"\nAttempting {url}...")
        try:
            # First try a GET to see if it's SSE
            resp = session.get(url, timeout=2, stream=True)
            print(f"  GET Statut: {resp.status_code}")
            print(f"  Headers: {dict(resp.headers)}")
            
            if resp.status_code == 200:
                # If it's SSE, we should have text/event-stream
                if "text/event-stream" in resp.headers.get("Content-Type", ""):
                    print(f"  [POTENTIAL] SSE detected on {url}")
                
            # Try an initialize POST
            init_payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "Test-Client", "version": "1.0.0"}
                }
            }
            post_resp = session.post(url, json=init_payload, timeout=2)
            print(f"  POST Statut: {post_resp.status_code}")
            if post_resp.status_code in [200, 202]:
                print(f"  [OK] Response received: {post_resp.text[:200]}")
                return url
        except Exception as e:
            print(f"  Error: {e}")
            
    return None

if __name__ == "__main__":
    found_url = probe_intellij_mcp()
    if found_url:
        print(f"\n[SUCCESS] IntelliJ MCP server found on {found_url}")
    else:
        print("\n[FAILED] MCP server not detected on standard endpoints of port 63342.")
