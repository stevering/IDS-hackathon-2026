import { createMCPClient } from '@ai-sdk/mcp';

const MCP_URL = 'http://127.0.0.1:64342/sse';

console.log(`Connecting to ${MCP_URL} using @ai-sdk/mcp...`);

const timeout = setTimeout(() => {
  console.error('GLOBAL TIMEOUT: Script hung for 30s, exiting');
  process.exit(1);
}, 30_000);

try {
  console.log('Creating MCP client...');
  const client = await createMCPClient({ transport: { type: 'sse', url: MCP_URL } });
  console.log('Client created successfully!');

  console.log('Listing tools...');
  const tools = await client.tools();
  const toolNames = Object.keys(tools);
  console.log(`Got ${toolNames.length} tools: ${toolNames.slice(0, 5).join(', ')}...`);

  if (toolNames.length > 0) {
    const testTool = toolNames.find(t => t.includes('list_directory')) || toolNames[0];
    console.log(`Calling tool: ${testTool}`);
    const start = Date.now();
    try {
      const result = await tools[testTool].execute({ path: '.' });
      console.log(`Tool result in ${Date.now() - start}ms:`, JSON.stringify(result).slice(0, 200));
    } catch (e) {
      console.error(`Tool call failed in ${Date.now() - start}ms:`, e.message);
    }
  }

  await client.close();
  console.log('Done!');
} catch (err) {
  console.error('Error:', err.message);
  console.error(err.stack);
} finally {
  clearTimeout(timeout);
  process.exit(0);
}
