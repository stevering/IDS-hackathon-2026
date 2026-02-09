import requests
import json
import time

MCP_BASE_URL = "http://127.0.0.1:64342"
SSE_URL = f"{MCP_BASE_URL}/sse"

def test_mcp_sse():
    print(f"--- Test du serveur MCP SSE sur {SSE_URL} ---")
    
    session = requests.Session()
    
    try:
        # 1. Établir la connexion SSE (GET)
        print(f"[1] Connexion au flux SSE...")
        response = session.get(SSE_URL, stream=True, timeout=5)
        
        post_url = None
        # On lit les premières lignes pour choper l'endpoint
        # IMPORTANT: On garde la connexion ouverte pour maintenir la session SSE!
        
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
                    print(f"  [OK] Endpoint de message reçu: {post_url}")
                    break
        
        if not post_url:
            print("  [FAILED] Pas d'URL de message reçue.")
            return

        # 2. Initialisation (POST)
        # On utilise la MÊME session requests.
        print(f"\n[2] Envoi de 'initialize' à {post_url}...")
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
        print(f"  Statut: {resp.status_code}")
        print(f"  Réponse: {resp.text}")
        
        if resp.status_code != 200 and resp.status_code != 202:
            print("  [ERROR] Échec de l'initialisation")
            return

        # 3. Notification Initialized
        print(f"\n[3] Envoi de 'notifications/initialized'...")
        notif_payload = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }
        resp = session.post(post_url, json=notif_payload)
        print(f"  Statut: {resp.status_code}")

        # 4. Liste des outils
        print(f"\n[4] Demande de 'tools/list'...")
        list_payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }
        resp = session.post(post_url, json=list_payload)
        print(f"  Statut: {resp.status_code}")
        if resp.status_code == 200:
            try:
                # La réponse SSE peut être asynchrone dans le flux, 
                # mais certains serveurs renvoient le résultat directement en HTTP 200.
                print(f"  Réponse: {resp.text}")
            except:
                print(f"  Réponse brute: {resp.text}")
        else:
             print(f"  Erreur: {resp.text}")

    except requests.exceptions.ConnectionError:
        print(f"  [FAILED] Impossible de se connecter à {MCP_BASE_URL}. Le serveur est-il lancé ?")
    except Exception as e:
        print(f"  [ERROR] {e}")

if __name__ == "__main__":
    test_mcp_sse()
