import requests
import json
import threading
import time

MCP_BASE_URL = "http://127.0.0.1:64342"
SSE_URL = f"{MCP_BASE_URL}/sse"

def listen_sse(session, url):
    print(f"[THREAD] Listening to SSE stream...")
    try:
        response = session.get(url, stream=True, timeout=10)
        for line in response.iter_lines():
            if line:
                decoded = line.decode('utf-8')
                if decoded.startswith('data:'):
                    data = decoded[5:].strip()
                    try:
                        # Try to parse the JSON if it's an RPC response
                        parsed = json.loads(data)
                        print(f"\n[SSE RECEIVE] {json.dumps(parsed, indent=2)}")
                    except:
                        print(f"\n[SSE RAW] {decoded}")
    except Exception as e:
        print(f"[THREAD ERROR] {e}")

def test_full_mcp():
    session = requests.Session()
    
    # 1. Initial connection to get the sessionId
    print("[1] SSE connection...")
    resp = session.get(SSE_URL, stream=True)
    post_url = None
    for line in resp.iter_lines():
        if line:
            decoded = line.decode('utf-8')
            if decoded.startswith('data:'):
                path = decoded[5:].strip()
                post_url = f"{MCP_BASE_URL}{path}"
                break
    
    if not post_url:
        print("Failed to retrieve post_url")
        return

    print(f"Post URL: {post_url}")
    
    # Launch the listener in background
    t = threading.Thread(target=listen_sse, args=(session, SSE_URL), daemon=True)
    t.start()
    
    time.sleep(1)

    # 2. Initialize
    print("\n[2] Initialize...")
    session.post(post_url, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "Test-Client", "version": "1.0.0"}
        }
    })
    
    time.sleep(1)

    # 3. List Tools
    print("\n[3] List Tools...")
    session.post(post_url, json={
        "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
    })
    
    # Wait for responses
    time.sleep(3)
    print("\n--- End of test ---")

if __name__ == "__main__":
    test_full_mcp()
