import requests
import json
import time

MCP_BASE_URL = "http://127.0.0.1:64342"
SSE_URL = f"{MCP_BASE_URL}/sse"

def test_mcp_sse():
    print(f"--- MCP SSE Server Test on {SSE_URL} ---")

    session = requests.Session()

    try:
        # 1. Establish the SSE connection (GET)
        print(f"[1] Connecting to SSE stream...")
        response = session.get(SSE_URL, stream=True, timeout=5)

        post_url = None
        # Read the first lines to grab the endpoint
        # IMPORTANT: Keep the connection open to maintain the SSE session!

        lines = []
        for line in response.iter_lines():
            if line:
                decoded_line = line.decode('utf-8')
                print(f"  SSE: {decoded_line}")
                lines.append(decoded_line)
                if decoded_line.startswith('data:'):
                    path = decoded_line[5:].strip()
                    if path.startswith('/'):
                        post_url = f"{MCP_BASE_URL}{path}"
                    else:
                        post_url = path
                    print(f"  [OK] Message endpoint received: {post_url}")
                    break

        if not post_url:
            print("  [FAILED] No message URL received.")
            return

        # 2. Initialization (POST)
        # Use the SAME requests session.
        print(f"\n[2] Sending 'initialize' to {post_url}...")
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

        resp = session.post(post_url, json=init_payload)
        print(f"  Status: {resp.status_code}")
        print(f"  Response: {resp.text}")

        if resp.status_code != 200 and resp.status_code != 202:
            print("  [ERROR] Initialization failed")
            return

        # 3. Notification Initialized
        print(f"\n[3] Sending 'notifications/initialized'...")
        notif_payload = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }
        resp = session.post(post_url, json=notif_payload)
        print(f"  Status: {resp.status_code}")

        # 4. List tools
        print(f"\n[4] Requesting 'tools/list'...")
        list_payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }
        resp = session.post(post_url, json=list_payload)
        print(f"  Status: {resp.status_code}")
        if resp.status_code == 200:
            try:
                # The SSE response may be asynchronous in the stream,
                # but some servers return the result directly in HTTP 200.
                print(f"  Response: {resp.text}")
            except:
                print(f"  Raw response: {resp.text}")
        else:
             print(f"  Error: {resp.text}")

    except requests.exceptions.ConnectionError:
        print(f"  [FAILED] Unable to connect to {MCP_BASE_URL}. Is the server running?")
    except Exception as e:
        print(f"  [ERROR] {e}")

if __name__ == "__main__":
    test_mcp_sse()
