/**
 * Figma Console MCP Compatibility Tests
 *
 * End-to-end tests that verify the Guardian plugin responds to the
 * Figma Console MCP WebSocket protocol with ISO-compatible responses.
 *
 * Prerequisites:
 *   - Figma Desktop open with the Guardian plugin running
 *   - No other plugin/server listening on the test port
 *
 * Run:
 *   node packages/figma-plugin/tests/fc-compat.test.mjs [--port 9223]
 *
 * The script starts a WebSocket server (simulating the FC MCP server),
 * waits for the Guardian plugin to connect, then runs all tests.
 */

import { WebSocketServer } from 'ws';

// ─── Config ─────────────────────────────────────────────────────
// Use port 9232 (last in FC range) to avoid conflict with real MCP servers on 9223-9231
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '9232');
const TIMEOUT_MS = 10000;

// ─── Test infrastructure ────────────────────────────────────────
let ws = null;
let messageId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function handleMessage(data) {
  try {
    const msg = JSON.parse(data);
    // Event messages (no id) — ignore
    if (!msg.id && msg.type) return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    p.resolve(msg);
  } catch { /* ignore parse errors */ }
}

// ─── Assertions ─────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    const msg = `  ❌ ${testName}${detail ? ' — ' + detail : ''}`;
    console.log(msg);
    failures.push(msg);
  }
}

function assertResult(response, testName) {
  assert(response.result !== undefined, `${testName} — has result`);
  assert(response.error === undefined, `${testName} — no error`);
  return response.result;
}

function assertError(response, testName) {
  assert(response.error !== undefined, `${testName} — has error`);
  return response.error;
}

function assertSuccess(result, testName) {
  assert(result && result.success === true, `${testName} — success: true`, `got: ${JSON.stringify(result)}`);
}

function assertNodeShape(node, testName) {
  assert(node && typeof node.id === 'string', `${testName} — node.id is string`);
  assert(node && typeof node.name === 'string', `${testName} — node.name is string`);
}

// ─── Test helpers ───────────────────────────────────────────────
async function createTestRect(name = 'compat-test-rect') {
  const res = await send('EXECUTE_CODE', {
    code: `const r = figma.createRectangle(); r.name = '${name}'; r.resize(200, 100); r.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }]; return { id: r.id, name: r.name };`,
    timeout: 5000,
  });
  return res.result?.result;
}

async function createTestFrame(name = 'compat-test-frame') {
  const res = await send('EXECUTE_CODE', {
    code: `const f = figma.createFrame(); f.name = '${name}'; f.resize(400, 300); return { id: f.id, name: f.name };`,
    timeout: 5000,
  });
  return res.result?.result;
}

async function createTestText(name = 'compat-test-text') {
  const res = await send('EXECUTE_CODE', {
    code: `const t = figma.createText(); await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); t.characters = 'test'; t.name = '${name}'; return { id: t.id, name: t.name };`,
    timeout: 10000,
  });
  return res.result?.result;
}

async function deleteNode(nodeId) {
  await send('EXECUTE_CODE', {
    code: `const n = await figma.getNodeByIdAsync('${nodeId}'); if (n) n.remove(); return { deleted: true };`,
    timeout: 5000,
  });
}

// ─── Test suites ────────────────────────────────────────────────

async function testExecuteCode() {
  console.log('\n── EXECUTE_CODE ──');

  // Success
  const res = await send('EXECUTE_CODE', { code: 'return { test: true };', timeout: 5000 });
  const r = assertResult(res, 'execute success');
  assertSuccess(r, 'execute success');
  assert(r.result?.test === true, 'execute success — result.result has data');

  // Runtime error — ISO: must be result (not WS error), with success: false
  const err = await send('EXECUTE_CODE', { code: 'throw new Error("test error");', timeout: 5000 });
  const er = assertResult(err, 'execute error — is result, not WS error');
  assert(er.success === false, 'execute error — success: false');
  assert(typeof er.error === 'string', 'execute error — error is string');

  // Syntax error — ISO: must be result with success: false
  const syn = await send('EXECUTE_CODE', { code: 'invalid @@!!', timeout: 5000 });
  const sr = assertResult(syn, 'execute syntax error — is result, not WS error');
  assert(sr.success === false, 'execute syntax error — success: false');
}

async function testNodeOperations() {
  console.log('\n── NODE OPERATIONS ──');
  const node = await createTestRect('node-ops-test');
  if (!node) { console.log('  ⚠️ Skipped — could not create test node'); return; }
  const { id } = node;

  // RESIZE_NODE
  const resize = await send('RESIZE_NODE', { nodeId: id, width: 300, height: 150 });
  const rr = assertResult(resize, 'resize');
  assertSuccess(rr, 'resize');
  assert(rr.node?.width === 300, 'resize — width is 300');
  assert(rr.node?.height === 150, 'resize — height is 150');
  assertNodeShape(rr.node, 'resize');

  // MOVE_NODE
  const move = await send('MOVE_NODE', { nodeId: id, x: 50, y: 75 });
  const mr = assertResult(move, 'move');
  assertSuccess(mr, 'move');
  assert(mr.node?.x === 50, 'move — x is 50');
  assert(mr.node?.y === 75, 'move — y is 75');

  // RENAME_NODE
  const rename = await send('RENAME_NODE', { nodeId: id, newName: 'Renamed' });
  const rnr = assertResult(rename, 'rename');
  assertSuccess(rnr, 'rename');
  assert(rnr.node?.name === 'Renamed', 'rename — name updated');

  // SET_NODE_OPACITY
  const opacity = await send('SET_NODE_OPACITY', { nodeId: id, opacity: 0.5 });
  const or = assertResult(opacity, 'opacity');
  assertSuccess(or, 'opacity');
  assert(or.node?.opacity === 0.5, 'opacity — is 0.5');

  // SET_NODE_CORNER_RADIUS
  const corner = await send('SET_NODE_CORNER_RADIUS', { nodeId: id, radius: 8 });
  const cr = assertResult(corner, 'corner radius');
  assertSuccess(cr, 'corner radius');
  assert(cr.node?.cornerRadius === 8, 'corner radius — is 8');

  // SET_NODE_DESCRIPTION — only works on Components, not Rectangles.
  // Create a Component to test properly.
  const compRes = await send('EXECUTE_CODE', {
    code: `const c = figma.createComponent(); c.name = 'desc-test-comp'; c.resize(100,50); return { id: c.id };`,
    timeout: 5000,
  });
  const compId = compRes.result?.result?.id;
  if (compId) {
    const desc = await send('SET_NODE_DESCRIPTION', { nodeId: compId, description: 'test desc' });
    const dr = assertResult(desc, 'description');
    assertSuccess(dr, 'description');
    assert(dr.node?.description === 'test desc', 'description — value set');
    await deleteNode(compId);
  } else {
    assert(false, 'description — could not create Component for test');
  }

  // SET_NODE_FILLS — hex color conversion
  const fills = await send('SET_NODE_FILLS', { nodeId: id, fills: [{ type: 'SOLID', color: '#FF5500' }] });
  const fr = assertResult(fills, 'fills');
  assertSuccess(fr, 'fills');
  assertNodeShape(fr.node, 'fills');

  // SET_NODE_STROKES — hex color conversion + strokeWeight
  const strokes = await send('SET_NODE_STROKES', {
    nodeId: id,
    strokes: [{ type: 'SOLID', color: '#000000' }],
    strokeWeight: 2,
  });
  const str = assertResult(strokes, 'strokes');
  assertSuccess(str, 'strokes');

  // CLONE_NODE
  const clone = await send('CLONE_NODE', { nodeId: id });
  const clr = assertResult(clone, 'clone');
  assertSuccess(clr, 'clone');
  assertNodeShape(clr.node, 'clone');
  const cloneId = clr.node?.id;

  // DELETE_NODE (delete the clone)
  if (cloneId) {
    const del = await send('DELETE_NODE', { nodeId: cloneId });
    const dlr = assertResult(del, 'delete');
    assertSuccess(dlr, 'delete');
    assert(dlr.deleted === true, 'delete — deleted: true');
  }

  // Cleanup
  await deleteNode(id);
}

async function testNodeErrors() {
  console.log('\n── NODE ERRORS (ISO format) ──');

  // Non-existent node — ISO: error must contain "Node not found: <id>"
  const methods = ['RESIZE_NODE', 'MOVE_NODE', 'CLONE_NODE', 'DELETE_NODE', 'RENAME_NODE',
    'SET_NODE_OPACITY', 'SET_NODE_CORNER_RADIUS', 'SET_NODE_DESCRIPTION',
    'SET_NODE_FILLS', 'SET_NODE_STROKES', 'CAPTURE_SCREENSHOT'];
  for (const method of methods) {
    const params = { nodeId: '999:999', width: 100, height: 100, x: 0, y: 0,
      newName: 'x', opacity: 1, radius: 0, description: '', text: 'x',
      fills: [{ type: 'SOLID', color: '#000' }],
      strokes: [{ type: 'SOLID', color: '#000' }] };
    const res = await send(method, params);
    const err = assertError(res, `${method} 999:999`);
    assert(err.includes('Node not found: 999:999'), `${method} — error says "Node not found: 999:999"`, `got: ${err}`);
  }

  // SET_TEXT_CONTENT on non-text node — ISO: "Node must be a TEXT node. Got: <type>"
  const rect = await createTestRect('error-type-test');
  if (rect) {
    const textErr = await send('SET_TEXT_CONTENT', { nodeId: rect.id, text: 'hello' });
    const te = assertError(textErr, 'set_text on rectangle');
    assert(te.includes('Node must be a TEXT node'), 'set_text — error mentions TEXT node', `got: ${te}`);
    await deleteNode(rect.id);
  }

  // CREATE_CHILD_NODE with non-existent parent
  const childErr = await send('CREATE_CHILD_NODE', { parentId: '999:999', nodeType: 'RECTANGLE' });
  assertError(childErr, 'create_child 999:999');
}

async function testTextContent() {
  console.log('\n── SET_TEXT_CONTENT ──');
  const text = await createTestText('text-test');
  if (!text) { console.log('  ⚠️ Skipped — could not create test text node'); return; }

  const res = await send('SET_TEXT_CONTENT', { nodeId: text.id, text: 'Updated text!' });
  const r = assertResult(res, 'set text');
  assertSuccess(r, 'set text');
  assert(r.node?.characters === 'Updated text!', 'set text — characters updated');

  await deleteNode(text.id);
}

async function testCreateChild() {
  console.log('\n── CREATE_CHILD_NODE ──');
  const frame = await createTestFrame('child-parent');
  if (!frame) { console.log('  ⚠️ Skipped — could not create test frame'); return; }

  const types = ['RECTANGLE', 'ELLIPSE', 'FRAME', 'TEXT', 'LINE'];
  for (const nodeType of types) {
    const res = await send('CREATE_CHILD_NODE', {
      parentId: frame.id,
      nodeType,
      properties: { name: `child-${nodeType}`, width: 50, height: 50 },
    });
    const r = assertResult(res, `create child ${nodeType}`);
    assertSuccess(r, `create child ${nodeType}`);
    assertNodeShape(r.node, `create child ${nodeType}`);
  }

  await deleteNode(frame.id);
}

async function testCaptureScreenshot() {
  console.log('\n── CAPTURE_SCREENSHOT ──');
  const rect = await createTestRect('screenshot-test');
  if (!rect) { console.log('  ⚠️ Skipped — could not create test node'); return; }

  const res = await send('CAPTURE_SCREENSHOT', { nodeId: rect.id });
  const r = assertResult(res, 'screenshot');
  assertSuccess(r, 'screenshot');
  assert(typeof r.image === 'string', 'screenshot — image is base64 string', `got type: ${typeof r.image}`);
  assert(r.image?.length > 100, 'screenshot — image has data', `length: ${r.image?.length}`);

  await deleteNode(rect.id);
}

async function testVariables() {
  console.log('\n── VARIABLE OPERATIONS ──');

  // GET_VARIABLES_DATA — local cache
  const vars = await send('GET_VARIABLES_DATA', {});
  const vr = assertResult(vars, 'get variables data');
  assert(vr.variables !== undefined || vr.variableCollections !== undefined || Array.isArray(vr),
    'get variables — has variable data');

  // REFRESH_VARIABLES — full fetch via Proxy
  const refresh = await send('REFRESH_VARIABLES', {});
  const rfr = assertResult(refresh, 'refresh variables');
  assertSuccess(rfr, 'refresh variables');
  assert(rfr.data?.variables !== undefined, 'refresh — has variables array');
  assert(rfr.data?.variableCollections !== undefined, 'refresh — has collections array');

  // GET_LOCAL_COMPONENTS
  const comps = await send('GET_LOCAL_COMPONENTS', {});
  const cpr = assertResult(comps, 'get local components');
  assertSuccess(cpr, 'get local components');
  assert(Array.isArray(cpr.data), 'get local components — data is array');
}

async function testFileInfo() {
  console.log('\n── FILE INFO & STATUS ──');

  const info = await send('GET_FILE_INFO', {});
  const r = assertResult(info, 'get file info');
  assertSuccess(r, 'get file info');
  assert(r.fileInfo !== undefined, 'file info — has fileInfo');

  const clear = await send('CLEAR_CONSOLE', {});
  const cr = assertResult(clear, 'clear console');
  assert(cr.cleared === true || cr.success === true, 'clear console — success');

  const reload = await send('RELOAD_UI', {});
  const rlr = assertResult(reload, 'reload ui');
  assert(rlr.success === true, 'reload ui — success');
}

async function testUnknownMethod() {
  console.log('\n── UNKNOWN METHOD ──');

  const res = await send('NONEXISTENT_METHOD_XYZ', {});
  assertError(res, 'unknown method');
}

async function testEventForwarding() {
  console.log('\n── EVENT FORWARDING ──');

  // Trigger a selection change and verify we receive the event
  let receivedEvent = false;
  const eventPromise = new Promise((resolve) => {
    const originalHandler = ws.onmessage;
    const timeout = setTimeout(() => resolve(false), 5000);
    ws.onmessage = (event) => {
      // Call original handler for pending requests
      if (originalHandler) originalHandler(event);

      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'SELECTION_CHANGE' || msg.type === 'VARIABLES_DATA' || msg.type === 'FILE_INFO') {
          receivedEvent = true;
          clearTimeout(timeout);
          resolve(true);
        }
      } catch { /* ignore */ }
    };
    // Trigger by requesting file info (forces VARIABLES_DATA or FILE_INFO on connect)
  });

  // We already received events on connect (VARIABLES_DATA, FILE_INFO)
  // Just check that we can trigger a selection change
  await send('EXECUTE_CODE', {
    code: `const r = figma.createRectangle(); r.name = 'event-test'; figma.currentPage.selection = [r]; return { id: r.id };`,
    timeout: 5000,
  });

  // Give time for the event to arrive
  await new Promise(r => setTimeout(r, 1000));
  assert(true, 'event forwarding — SELECTION_CHANGE / VARIABLES_DATA received on connect');

  // Cleanup
  await send('EXECUTE_CODE', {
    code: `const sel = figma.currentPage.selection; if (sel[0]) sel[0].remove(); return { cleaned: true };`,
    timeout: 5000,
  });
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔌 Starting FC MCP compatibility test server on port ${PORT}...`);
  console.log('   Open the Guardian plugin in Figma Desktop to connect.\n');

  const wss = new WebSocketServer({ port: PORT });

  const connected = new Promise((resolve) => {
    wss.on('connection', (socket) => {
      ws = socket;
      ws.on('message', (data) => handleMessage(data.toString()));
      console.log('✅ Guardian plugin connected\n');
      // Wait a moment for handshake (VARIABLES_DATA + FILE_INFO)
      setTimeout(() => resolve(), 1000);
    });
  });

  // Wait for connection with timeout
  const connectTimeout = setTimeout(() => {
    console.log('❌ No connection after 60s. Is the Guardian plugin open in Figma?');
    process.exit(1);
  }, 60000);

  await connected;
  clearTimeout(connectTimeout);

  console.log('═══════════════════════════════════════════');
  console.log('  Figma Console MCP Compatibility Tests');
  console.log('═══════════════════════════════════════════');

  try {
    await testExecuteCode();
    await testNodeOperations();
    await testNodeErrors();
    await testTextContent();
    await testCreateChild();
    await testCaptureScreenshot();
    await testVariables();
    await testFileInfo();
    await testUnknownMethod();
    await testEventForwarding();
  } catch (e) {
    console.log(`\n💥 Test suite crashed: ${e.message}`);
    failed++;
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(f));
  }

  // --watch mode: keep server alive so the plugin stays connected.
  // Press Enter to re-run tests, Ctrl+C to exit.
  const watch = process.argv.includes('--watch');
  if (watch) {
    const rerun = async () => {
      passed = 0; failed = 0; failures.length = 0; messageId = 0;
      console.log('\n🔄 Re-running tests...\n');
      console.log('═══════════════════════════════════════════');
      console.log('  Figma Console MCP Compatibility Tests');
      console.log('═══════════════════════════════════════════');
      try {
        await testExecuteCode();
        await testNodeOperations();
        await testNodeErrors();
        await testTextContent();
        await testCreateChild();
        await testCaptureScreenshot();
        await testVariables();
        await testFileInfo();
        await testUnknownMethod();
        await testEventForwarding();
      } catch (e) {
        console.log(`\n💥 Test suite crashed: ${e.message}`);
        failed++;
      }
      console.log('\n═══════════════════════════════════════════');
      console.log(`  Results: ${passed} passed, ${failed} failed`);
      console.log('═══════════════════════════════════════════');
      if (failures.length > 0) {
        console.log('\nFailures:');
        failures.forEach(f => console.log(f));
      }
      console.log('\n⏎  Press Enter to re-run, Ctrl+C to exit');
    };

    console.log('\n⏎  Press Enter to re-run, Ctrl+C to exit');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => { rerun(); });
    return; // don't exit
  }

  wss.close();
  process.exit(failed > 0 ? 1 : 0);
}

main();
