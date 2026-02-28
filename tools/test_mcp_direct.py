import requests
import json
import time

MCP_BASE_URL = "http://127.0.0.1:3845"
# For IntelliJ, the server is often accessible via a simple endpoint if the proxy is already in place
# But let's test the direct approach recommended by the MCP SSE protocol

def test_mcp_direct():
    print(f"--- MCP Server Test (Direct) on {MCP_BASE_URL}/mcp ---")
    session = requests.Session()
    post_url = f"{MCP_BASE_URL}/mcp"

    try:
        # 1. Initialization
        print(f"[1] Sending 'initialize' to {post_url}...")
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

        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Mcp-Protocol-Version': '2024-11-05'
        }

        resp = session.post(post_url, json=init_payload, headers=headers)
        print(f"  Status: {resp.status_code}")
        print(f"  Headers: {resp.headers}")

        session_id = resp.headers.get('Mcp-Session-Id')
        if session_id:
            print(f"  [OK] Session ID received: {session_id}")
            headers['Mcp-Session-Id'] = session_id

        # 2. Notification Initialized
        print(f"\n[2] Sending 'notifications/initialized'...")
        notif_payload = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }
        resp = session.post(post_url, json=notif_payload, headers=headers)
        print(f"  Status: {resp.status_code}")

        # 3. List tools
        print(f"\n[3] Requesting 'tools/list'...")
        list_payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }
        resp = session.post(post_url, json=list_payload, headers=headers)
        print(f"  Status: {resp.status_code}")
        if resp.status_code == 200:
            print(f"  Response: {resp.text}")
        else:
             print(f"  Error: {resp.text}")

    except Exception as e:
        print(f"  [ERROR] {e}")

if __name__ == "__main__":
    test_mcp_direct()
