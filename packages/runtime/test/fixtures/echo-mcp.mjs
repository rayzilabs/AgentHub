import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echo text with ECHO_PREFIX',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
      },
    });
  } else if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `${process.env.ECHO_PREFIX ?? ''}${msg.params.arguments.text}` }] },
    });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
