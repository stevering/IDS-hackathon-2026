import requests
import json
import threading
import time

MCP_BASE_URL = "http://127.0.0.1:64342"
SSE_URL = f"{MCP_BASE_URL}/sse"

def listen_sse(session, url):
    print(f"[THREAD] Écoute du flux SSE...")
    try:
        response = session.get(url, stream=True, timeout=10)
        for line in response.iter_lines():
            if line:
                decoded = line.decode('utf-8')
                if decoded.startswith('data:'):
                    data = decoded[5:].strip()
                    try:
                        # Tenter de parser le JSON si c'est une réponse RPC
                        parsed = json.loads(data)
                        print(f"\n[SSE RECEIVE] {json.dumps(parsed, indent=2)}")
                    except:
                        print(f"\n[SSE RAW] {decoded}")
    except Exception as e:
        print(f"[THREAD ERROR] {e}")

def test_full_mcp():
    session = requests.Session()
    
    # 1. Connexion initiale pour avoir le sessionId
    print("[1] Connexion SSE...")
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
        print("Échec récupération post_url")
        return

    print(f"Post URL: {post_url}")
    
    # Lancer l'écouteur en background
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
    
    # Attendre les réponses
    time.sleep(3)
    print("\n--- Fin du test ---")

if __name__ == "__main__":
    test_full_mcp()
