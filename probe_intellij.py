import requests
import json

# Port standard pour le serveur embarqué d'IntelliJ
INTELLIJ_PORT = 63342
MCP_BASE_URL = f"http://127.0.0.1:{INTELLIJ_PORT}"

# On va tester les endpoints classiques suspectés pour MCP dans IntelliJ
# Souvent /mcp ou /api/mcp ou via un transport spécifique
endpoints = ["/mcp", "/sse", "/api/mcp"]

def probe_intellij_mcp():
    print(f"--- Recherche du serveur MCP sur IntelliJ (port {INTELLIJ_PORT}) ---")
    session = requests.Session()
    
    for ep in endpoints:
        url = f"{MCP_BASE_URL}{ep}"
        print(f"\nTentative sur {url}...")
        try:
            # On tente d'abord un GET pour voir si c'est du SSE
            resp = session.get(url, timeout=2, stream=True)
            print(f"  GET Statut: {resp.status_code}")
            print(f"  Headers: {dict(resp.headers)}")
            
            if resp.status_code == 200:
                # Si c'est du SSE, on devrait avoir text/event-stream
                if "text/event-stream" in resp.headers.get("Content-Type", ""):
                    print(f"  [POTENTIAL] SSE détecté sur {url}")
                
            # On tente un initialize en POST
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
                print(f"  [OK] Réponse reçue: {post_resp.text[:200]}")
                return url
        except Exception as e:
            print(f"  Erreur: {e}")
            
    return None

if __name__ == "__main__":
    found_url = probe_intellij_mcp()
    if found_url:
        print(f"\n[SUCCESS] Serveur MCP IntelliJ trouvé sur {found_url}")
    else:
        print("\n[FAILED] Serveur MCP non détecté sur les endpoints standards du port 63342.")
