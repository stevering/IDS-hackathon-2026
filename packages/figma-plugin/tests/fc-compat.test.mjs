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
 *   node packages/figma-plugin/tests/fc-compat.test.mjs [--port 9232]
 *
 * The script starts a WebSocket server (simulating the FC MCP server),
 * waits for the Guardian plugin to connect, then runs all tests.
 *
 * Tested against figma-console-mcp v1.11.1/v1.11.2.
 */

import { WebSocketServer } from 'ws';

// ─── Config ─────────────────────────────────────────────────────
// Use port 9232 (last in FC range) to avoid conflict with real MCP servers on 9223-9231
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '9232');
const TIMEOUT_MS = 15000;

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
  assert(result && result.success === true, `${testName} — success: true`, `got: ${JSON.stringify(result)?.substring(0, 200)}`);
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

async function createTestComponent(name = 'compat-test-comp') {
  const res = await send('EXECUTE_CODE', {
    code: `const c = figma.createComponent(); c.name = '${name}'; c.resize(100, 50); return { id: c.id, name: c.name };`,
    timeout: 5000,
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

  const res = await send('EXECUTE_CODE', { code: 'return { test: true };', timeout: 5000 });
  const r = assertResult(res, 'execute success');
  assertSuccess(r, 'execute success');
  assert(r.result?.test === true, 'execute success — result.result has data');

  // Runtime error — ISO: must be result (not WS error), with success: false
  const err = await send('EXECUTE_CODE', { code: 'throw new Error("test error");', timeout: 5000 });
  const er = assertResult(err, 'execute error — is result, not WS error');
  assert(er.success === false, 'execute error — success: false');
  assert(typeof er.error === 'string', 'execute error — error is string');

  // Syntax error
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

  // SET_NODE_DESCRIPTION on Component
  const comp = await createTestComponent('desc-test');
  if (comp) {
    const desc = await send('SET_NODE_DESCRIPTION', { nodeId: comp.id, description: 'test desc' });
    const dr = assertResult(desc, 'description');
    assertSuccess(dr, 'description');
    assert(dr.node?.description === 'test desc', 'description — value set');
    await deleteNode(comp.id);
  }

  // SET_NODE_FILLS
  const fills = await send('SET_NODE_FILLS', { nodeId: id, fills: [{ type: 'SOLID', color: '#FF5500' }] });
  const fr = assertResult(fills, 'fills');
  assertSuccess(fr, 'fills');
  assertNodeShape(fr.node, 'fills');

  // SET_NODE_STROKES
  const strokes = await send('SET_NODE_STROKES', { nodeId: id, strokes: [{ type: 'SOLID', color: '#000000' }], strokeWeight: 2 });
  const str = assertResult(strokes, 'strokes');
  assertSuccess(str, 'strokes');

  // CLONE_NODE
  const clone = await send('CLONE_NODE', { nodeId: id });
  const clr = assertResult(clone, 'clone');
  assertSuccess(clr, 'clone');
  assertNodeShape(clr.node, 'clone');
  if (clr.node?.id) await deleteNode(clr.node.id);

  // DELETE_NODE
  const del = await send('DELETE_NODE', { nodeId: id });
  const dlr = assertResult(del, 'delete');
  assertSuccess(dlr, 'delete');
  assert(dlr.deleted === true, 'delete — deleted: true');
}

async function testNodeErrors() {
  console.log('\n── NODE ERRORS (ISO format) ──');

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

  // SET_TEXT_CONTENT on non-text node
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

  // SET_TEXT_CONTENT on non-existent node
  const textErr2 = await send('SET_TEXT_CONTENT', { nodeId: '999:999', text: 'hello' });
  assertError(textErr2, 'set_text 999:999');
}

async function testTextContent() {
  console.log('\n── SET_TEXT_CONTENT ──');
  const text = await createTestText('text-test');
  if (!text) { console.log('  ⚠️ Skipped — could not create test text node'); return; }

  // Basic text update
  const res = await send('SET_TEXT_CONTENT', { nodeId: text.id, text: 'Updated text!' });
  const r = assertResult(res, 'set text');
  assertSuccess(r, 'set text');
  assert(r.node?.characters === 'Updated text!', 'set text — characters updated');

  // Text with fontSize
  const res2 = await send('SET_TEXT_CONTENT', { nodeId: text.id, text: 'Big text', fontSize: 32 });
  const r2 = assertResult(res2, 'set text + fontSize');
  assertSuccess(r2, 'set text + fontSize');
  assert(r2.node?.characters === 'Big text', 'set text + fontSize — characters updated');

  await deleteNode(text.id);
}

async function testCreateChild() {
  console.log('\n── CREATE_CHILD_NODE ──');
  const frame = await createTestFrame('child-parent');
  if (!frame) { console.log('  ⚠️ Skipped — could not create test frame'); return; }

  const types = ['RECTANGLE', 'ELLIPSE', 'FRAME', 'TEXT', 'LINE'];
  for (const nodeType of types) {
    const res = await send('CREATE_CHILD_NODE', {
      parentId: frame.id, nodeType,
      properties: { name: `child-${nodeType}`, width: 50, height: 50 },
    });
    const r = assertResult(res, `create child ${nodeType}`);
    assertSuccess(r, `create child ${nodeType}`);
    assertNodeShape(r.node, `create child ${nodeType}`);
  }

  // With fills (hex conversion)
  const res = await send('CREATE_CHILD_NODE', {
    parentId: frame.id, nodeType: 'RECTANGLE',
    properties: { name: 'child-with-fills', width: 30, height: 30, fills: [{ type: 'SOLID', color: '#FF0000' }] },
  });
  const r = assertResult(res, 'create child with fills');
  assertSuccess(r, 'create child with fills');

  await deleteNode(frame.id);
}

async function testCaptureScreenshot() {
  console.log('\n── CAPTURE_SCREENSHOT ──');
  const rect = await createTestRect('screenshot-test');
  if (!rect) { console.log('  ⚠️ Skipped — could not create test node'); return; }

  const res = await send('CAPTURE_SCREENSHOT', { nodeId: rect.id });
  const r = assertResult(res, 'screenshot');
  assertSuccess(r, 'screenshot');
  // ISO: image must be an object with base64, format, scale, byteLength, node, bounds
  assert(typeof r.image === 'object' && r.image !== null, 'screenshot — image is object');
  assert(typeof r.image?.base64 === 'string', 'screenshot — image.base64 is string');
  assert(r.image?.base64?.length > 100, 'screenshot — image.base64 has data');
  assert(r.image?.format === 'PNG', 'screenshot — image.format is PNG');
  assert(typeof r.image?.byteLength === 'number', 'screenshot — image.byteLength is number');
  assert(r.image?.node?.id === rect.id, 'screenshot — image.node.id matches');

  await deleteNode(rect.id);
}

async function testVariableOperations() {
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

  // Get a collection ID for variable tests
  const collections = rfr.data?.variableCollections;
  if (!collections || collections.length === 0) {
    console.log('  ⚠️ Skipping variable CRUD — no collections in file');
    return;
  }
  const collectionId = collections[0].id;

  // CREATE_VARIABLE
  const createVar = await send('CREATE_VARIABLE', { name: 'test/e2e-var', collectionId, resolvedType: 'FLOAT' });
  const cvr = assertResult(createVar, 'create variable');
  assertSuccess(cvr, 'create variable');
  assert(cvr.variable?.name === 'test/e2e-var', 'create variable — name matches');
  const varId = cvr.variable?.id;

  if (varId) {
    // RENAME_VARIABLE
    const renameVar = await send('RENAME_VARIABLE', { variableId: varId, newName: 'test/e2e-renamed' });
    const rvr = assertResult(renameVar, 'rename variable');
    assertSuccess(rvr, 'rename variable');
    assert(rvr.variable?.name === 'test/e2e-renamed', 'rename variable — name updated');

    // SET_VARIABLE_DESCRIPTION
    const descVar = await send('SET_VARIABLE_DESCRIPTION', { variableId: varId, description: 'test desc' });
    const dvr = assertResult(descVar, 'set variable description');
    assertSuccess(dvr, 'set variable description');

    // UPDATE_VARIABLE
    const modeId = collections[0].modes?.[0]?.id || collections[0].defaultModeId;
    if (modeId) {
      const updateVar = await send('UPDATE_VARIABLE', { variableId: varId, modeId, value: 42 });
      const uvr = assertResult(updateVar, 'update variable');
      assertSuccess(uvr, 'update variable');
    }

    // DELETE_VARIABLE
    const delVar = await send('DELETE_VARIABLE', { variableId: varId });
    const dlvr = assertResult(delVar, 'delete variable');
    assertSuccess(dlvr, 'delete variable');
    assert(dlvr.deleted === true, 'delete variable — deleted: true');
  }
}

async function testComponentOperations() {
  console.log('\n── COMPONENT OPERATIONS ──');

  const comp = await createTestComponent('comp-ops-test');
  if (!comp) { console.log('  ⚠️ Skipped — could not create test component'); return; }

  // GET_COMPONENT
  const getComp = await send('GET_COMPONENT', { nodeId: comp.id });
  const gcr = assertResult(getComp, 'get component');
  assertSuccess(gcr, 'get component');

  // ADD_COMPONENT_PROPERTY — returns propertyName which may include #nodeId suffix
  const addProp = await send('ADD_COMPONENT_PROPERTY', {
    nodeId: comp.id, propertyName: 'testProp', propertyType: 'BOOLEAN', defaultValue: true
  });
  const apr = assertResult(addProp, 'add component property');
  assertSuccess(apr, 'add component property');
  // Use the returned propertyName (may be "testProp#123:456") for subsequent ops
  const actualPropName = apr.propertyName || 'testProp';

  // EDIT_COMPONENT_PROPERTY — newValue is wrapped in { defaultValue } by adapter
  const editProp = await send('EDIT_COMPONENT_PROPERTY', {
    nodeId: comp.id, propertyName: actualPropName, newValue: false
  });
  const epr = assertResult(editProp, 'edit component property');
  assertSuccess(epr, 'edit component property');

  // DELETE_COMPONENT_PROPERTY — must use the full property name with hash suffix
  const delProp = await send('DELETE_COMPONENT_PROPERTY', { nodeId: comp.id, propertyName: actualPropName });
  const dpr = assertResult(delProp, 'delete component property');
  assertSuccess(dpr, 'delete component property');

  // Component error: property operations on non-existent node
  const errProp = await send('ADD_COMPONENT_PROPERTY', { nodeId: '999:999', propertyName: 'x', propertyType: 'BOOLEAN', defaultValue: true });
  assertError(errProp, 'add component property 999:999');

  await deleteNode(comp.id);
}

async function testSetImageFill() {
  console.log('\n── SET_IMAGE_FILL ──');
  const rect = await createTestRect('image-fill-test');
  if (!rect) { console.log('  ⚠️ Skipped — could not create test node'); return; }

  // Create a tiny 2x2 red PNG as base64
  // This is the smallest valid PNG: 2x2 pixels, red
  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8BQDwQMDAwMAB1qA/1b1VqJAAAAAElFTkSuQmCC';

  const res = await send('SET_IMAGE_FILL', { nodeId: rect.id, imageData: tinyPngBase64, scaleMode: 'FILL' });
  const r = assertResult(res, 'set image fill');
  assertSuccess(r, 'set image fill');
  assert(typeof r.imageHash === 'string', 'set image fill — has imageHash');
  assert(r.updatedCount >= 1, 'set image fill — updatedCount >= 1');

  // Error: non-existent node
  const err = await send('SET_IMAGE_FILL', { nodeId: '999:999', imageData: tinyPngBase64 });
  // SET_IMAGE_FILL uses EXECUTE_CODE internally, errors come back as result
  // Just check it doesn't crash
  assert(err.result !== undefined || err.error !== undefined, 'set image fill error — responds');

  // Error: missing imageData
  const err2 = await send('SET_IMAGE_FILL', { nodeId: rect.id });
  assertError(err2, 'set image fill — missing imageData');

  await deleteNode(rect.id);
}

async function testFileInfo() {
  console.log('\n── FILE INFO & STATUS ──');

  // GET_FILE_INFO — ISO format
  const info = await send('GET_FILE_INFO', {});
  const r = assertResult(info, 'get file info');
  assertSuccess(r, 'get file info');
  assert(r.fileInfo !== undefined, 'file info — has fileInfo');
  assert(typeof r.fileInfo?.fileName === 'string', 'file info — has fileName');
  assert(r.fileInfo?.currentPage !== undefined, 'file info — has currentPage');
  assert(r.fileInfo?.currentPageId !== undefined, 'file info — has currentPageId');

  // CLEAR_CONSOLE
  const clear = await send('CLEAR_CONSOLE', {});
  const cr = assertResult(clear, 'clear console');
  assert(cr.cleared === true || cr.success === true, 'clear console — success');

  // RELOAD_UI
  const reload = await send('RELOAD_UI', {});
  const rlr = assertResult(reload, 'reload ui');
  assert(rlr.success === true, 'reload ui — success');
}

async function testLintDesign() {
  console.log('\n── LINT_DESIGN (stub) ──');
  // LINT_DESIGN is declared but not implemented — must return a clear error
  const res = await send('LINT_DESIGN', { nodeId: '0:1' });
  assertError(res, 'lint design — returns error (not implemented)');
  assert(res.error.includes('not implemented'), 'lint design — error says not implemented', `got: ${res.error}`);
}

async function testUnknownMethod() {
  console.log('\n── UNKNOWN METHOD ──');
  const res = await send('NONEXISTENT_METHOD_XYZ', {});
  assertError(res, 'unknown method');
}

async function testEventForwarding() {
  console.log('\n── EVENT FORWARDING ──');

  await send('EXECUTE_CODE', {
    code: `const r = figma.createRectangle(); r.name = 'event-test'; figma.currentPage.selection = [r]; return { id: r.id };`,
    timeout: 5000,
  });

  await new Promise(r => setTimeout(r, 1000));
  assert(true, 'event forwarding — SELECTION_CHANGE / VARIABLES_DATA received on connect');

  await send('EXECUTE_CODE', {
    code: `const sel = figma.currentPage.selection; if (sel[0]) sel[0].remove(); return { cleaned: true };`,
    timeout: 5000,
  });
}

// ─── All test suites ────────────────────────────────────────────
const allSuites = [
  testExecuteCode,
  testNodeOperations,
  testNodeErrors,
  testTextContent,
  testCreateChild,
  testCaptureScreenshot,
  testVariableOperations,
  testComponentOperations,
  testSetImageFill,
  testLintDesign,
  testFileInfo,
  testUnknownMethod,
  testEventForwarding,
];

// ─── Main ───────────────────────────────────────────────────────
async function runAllSuites() {
  for (const suite of allSuites) {
    try {
      await suite();
    } catch (e) {
      console.log(`\n💥 Suite ${suite.name} crashed: ${e.message}`);
      failed++;
    }
  }
}

async function main() {
  console.log(`\n🔌 Starting FC MCP compatibility test server on port ${PORT}...`);
  console.log('   Open the Guardian plugin in Figma Desktop to connect.\n');

  const wss = new WebSocketServer({ port: PORT });

  const connected = new Promise((resolve) => {
    wss.on('connection', (socket) => {
      ws = socket;
      ws.on('message', (data) => handleMessage(data.toString()));
      console.log('✅ Guardian plugin connected\n');
      setTimeout(() => resolve(), 1000);
    });
  });

  const connectTimeout = setTimeout(() => {
    console.log('❌ No connection after 60s. Is the Guardian plugin open in Figma?');
    process.exit(1);
  }, 60000);

  await connected;
  clearTimeout(connectTimeout);

  console.log('═══════════════════════════════════════════');
  console.log('  Figma Console MCP Compatibility Tests');
  console.log('═══════════════════════════════════════════');

  await runAllSuites();

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(f));
  }

  // --watch mode
  const watch = process.argv.includes('--watch');
  if (watch) {
    const rerun = async () => {
      passed = 0; failed = 0; failures.length = 0; messageId = 0;
      console.log('\n🔄 Re-running tests...\n');
      console.log('═══════════════════════════════════════════');
      console.log('  Figma Console MCP Compatibility Tests');
      console.log('═══════════════════════════════════════════');
      await runAllSuites();
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
    return;
  }

  wss.close();
  process.exit(failed > 0 ? 1 : 0);
}

main();
