const SSE_URL = "http://127.0.0.1:64342/sse";

async function run() {
  console.log("1) Connecting to SSE...");
  const sseRes = await fetch(SSE_URL);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sessionEndpoint = null;

  while (!sessionEndpoint) {
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE closed");
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (line.startsWith("data: /message?sessionId=")) {
        sessionEndpoint = "http://127.0.0.1:64342" + line.slice(6).trim();
      }
    }
  }
  console.log("2) Endpoint:", sessionEndpoint);

  const allSseData = [];
  async function pumpAll() {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allSseData.push(decoder.decode(value, { stream: true }));
      }
    } catch {}
  }
  pumpAll();

  function findResponse(id) {
    const raw = allSseData.join("");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: {")) {
        try {
          const obj = JSON.parse(trimmed.slice(6));
          if (obj.id === id) return obj;
        } catch {}
      }
    }
    return null;
  }

  async function waitForResponse(id, maxMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const resp = findResponse(id);
      if (resp) return resp;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error("Timeout waiting for response id=" + id);
  }

  async function rpc(method, params, id) {
    const body = { jsonrpc: "2.0", method, params: params || {} };
    if (id !== undefined) body.id = id;
    console.log("\n>> " + method);
    const res = await fetch(sessionEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log("   HTTP:", res.status);
    if (id !== undefined) {
      const resp = await waitForResponse(id);
      return resp;
    }
    return null;
  }

  // Initialize
  const initResp = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" }
  }, 1);
  console.log("   Server:", initResp.result?.serverInfo?.name);

  // Initialized notification
  await rpc("notifications/initialized");
  await new Promise(r => setTimeout(r, 500));

  // List tools
  const toolsResp = await rpc("tools/list", {}, 2);
  const tools = toolsResp?.result?.tools || [];
  console.log("\n3) Found", tools.length, "tools:");
  tools.forEach(t => console.log("   -", t.name));

  if (tools.length > 0) {
    // Find a simple tool to test
    const testTool = tools.find(t => t.name === "list_directory_tree")
      || tools.find(t => t.name.includes("list"))
      || tools[0];
    console.log("\n4) Calling tool:", testTool.name);
    
    const inputSchema = testTool.inputSchema;
    console.log("   Input schema:", JSON.stringify(inputSchema).slice(0, 200));
    
    let args = {};
    if (inputSchema?.properties?.path) args.path = ".";
    if (inputSchema?.properties?.directoryPath) args.directoryPath = ".";
    console.log("   Args:", JSON.stringify(args));

    const t0 = Date.now();
    try {
      const callResp = await rpc("tools/call", { name: testTool.name, arguments: args }, 3);
      const elapsed = Date.now() - t0;
      console.log("   Elapsed:", elapsed, "ms");
      console.log("   Result:", JSON.stringify(callResp).slice(0, 500));
    } catch (e) {
      const elapsed = Date.now() - t0;
      console.log("   FAILED after", elapsed, "ms:", e.message);
    }
  }

  reader.cancel();
  process.exit(0);
}

run().catch(e => { console.error("ERROR:", e); process.exit(1); });
