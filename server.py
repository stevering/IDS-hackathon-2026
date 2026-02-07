from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import json
import requests
import os
import threading

class ProxyHandler(BaseHTTPRequestHandler):
    FIGMA_MCP_URL = os.environ.get('FIGMA_MCP_URL', 'http://127.0.0.1:3845')
    STORYBOOK_MCP_URL = os.environ.get('STORYBOOK_MCP_URL', 'http://localhost:8002')

    _figma_session_id = None
    _figma_initialized = False
    _figma_init_response = None
    _lock = threading.Lock()

    def do_GET(self):
        if self.path == '/' or self.path == '/test.html':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            with open('test.html', 'rb') as f:
                self.wfile.write(f.read())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/proxy/figma':
            self._proxy_figma_mcp()
        elif path == '/proxy/storybook':
            self._proxy_request(self.STORYBOOK_MCP_URL)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error": "Route not found"}')

    @staticmethod
    def _parse_sse_json(response):
        content_type = response.headers.get('Content-Type', '')
        body = response.text.strip()

        if 'text/event-stream' in content_type:
            for line in body.splitlines():
                line = line.strip()
                if line.startswith('data:'):
                    data_str = line[5:].strip()
                    if data_str:
                        try:
                            return json.loads(data_str)
                        except json.JSONDecodeError:
                            continue
            return None

        if body:
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                return None
        return None

    def _forward_to_figma(self, data):
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Mcp-Protocol-Version': '2024-11-05'
        }
        if ProxyHandler._figma_session_id:
            headers['Mcp-Session-Id'] = ProxyHandler._figma_session_id

        response = requests.post(
            f"{self.FIGMA_MCP_URL}/mcp",
            headers=headers,
            json=data,
            timeout=30
        )

        new_session_id = response.headers.get('Mcp-Session-Id')
        if new_session_id:
            ProxyHandler._figma_session_id = new_session_id

        return response

    def _ensure_figma_initialized(self):
        with ProxyHandler._lock:
            if ProxyHandler._figma_initialized:
                return True
            try:
                init_data = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"roots": {"listChanged": True}, "sampling": {}},
                        "clientInfo": {"name": "DS-AI-Guardian-Proxy", "version": "1.0.0"}
                    }
                }
                response = self._forward_to_figma(init_data)
                print(f"[PROXY] init response status={response.status_code} content-type={response.headers.get('Content-Type')} body={response.text[:500]}")

                if response.status_code == 200:
                    parsed = self._parse_sse_json(response)
                    if parsed:
                        ProxyHandler._figma_init_response = parsed
                        notif = {
                            "jsonrpc": "2.0",
                            "method": "notifications/initialized",
                            "params": {}
                        }
                        self._forward_to_figma(notif)
                        ProxyHandler._figma_initialized = True
                        print(f"[PROXY] Figma MCP initialized, session={ProxyHandler._figma_session_id}")
                        return True
                    else:
                        print(f"[PROXY] Could not parse init response")
                        return False
                else:
                    print(f"[PROXY] Figma MCP init failed: {response.status_code} {response.text[:300]}")
                    return False
            except Exception as e:
                print(f"[PROXY] Figma MCP init error: {e}")
                return False

    def _proxy_figma_mcp(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body) if body else {}
            method = data.get('method', '')

            if method == 'initialize':
                if not self._ensure_figma_initialized():
                    self.send_response(503)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "jsonrpc": "2.0",
                        "id": data.get("id"),
                        "error": {"code": -1, "message": "Cannot connect to Figma MCP"}
                    }).encode())
                    return
                resp_data = dict(ProxyHandler._figma_init_response)
                resp_data["id"] = data.get("id")
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                if ProxyHandler._figma_session_id:
                    self.send_header('MCP-Session-Id', ProxyHandler._figma_session_id)
                self.end_headers()
                self.wfile.write(json.dumps(resp_data).encode())
                return

            if method == 'notifications/initialized':
                self.send_response(202)
                self.end_headers()
                return

            if not ProxyHandler._figma_initialized:
                self._ensure_figma_initialized()

            response = self._forward_to_figma(data)

            parsed = self._parse_sse_json(response)
            self.send_response(response.status_code)
            self.send_header('Content-Type', 'application/json')
            if ProxyHandler._figma_session_id:
                self.send_header('MCP-Session-Id', ProxyHandler._figma_session_id)
            self.end_headers()
            if parsed:
                self.wfile.write(json.dumps(parsed).encode())
            else:
                self.wfile.write(response.content if response.content else b'{}')

        except requests.exceptions.ConnectionError:
            ProxyHandler._figma_initialized = False
            ProxyHandler._figma_session_id = None
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": "Cannot connect to Figma MCP"
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _proxy_request(self, target_url):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'MCP-Protocol-Version': '2024-11-05'
            }
            if 'MCP-Session-Id' in self.headers:
                headers['MCP-Session-Id'] = self.headers['MCP-Session-Id']
            response = requests.post(target_url, headers=headers, data=body, timeout=30)
            self.send_response(response.status_code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(response.content if response.content else b'{}')
        except requests.exceptions.ConnectionError:
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Cannot connect to {target_url}"}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        print(f"[{self.client_address[0]}] {format % args}")

if __name__ == '__main__':
    PORT = 3000
    server = HTTPServer(('127.0.0.1', PORT), ProxyHandler)
    print(f"🚀 Proxy serveur sur http://127.0.0.1:{PORT}")
    print(f"   Figma MCP: {ProxyHandler.FIGMA_MCP_URL}")
    print(f"   Storybook MCP: {ProxyHandler.STORYBOOK_MCP_URL}")
    print("Ctrl+C pour arrêter...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n✋ Serveur arrêté")