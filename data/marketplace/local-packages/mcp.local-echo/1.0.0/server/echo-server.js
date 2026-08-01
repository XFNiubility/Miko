#!/usr/bin/env node

const serverInfo = { name: 'marketplace-echo', version: '1.0.0' }

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function toolList() {
  return {
    tools: [
      {
        name: 'echo_text',
        description: 'Echo text with the marketplace MCP prefix.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to echo.' },
          },
          required: ['text'],
        },
      },
    ],
  }
}

function callTool(params) {
  if (params?.name !== 'echo_text') {
    throw new Error(`Unknown tool: ${params?.name}`)
  }
  const prefix = process.env.MARKETPLACE_ECHO_PREFIX || 'Marketplace'
  const text = String(params?.arguments?.text ?? '')
  return {
    content: [{ type: 'text', text: `${prefix}: ${text}` }],
  }
}

function handle(request) {
  if (!request || request.jsonrpc !== '2.0') return
  if (request.id === undefined) return

  try {
    switch (request.method) {
      case 'initialize':
        result(request.id, {
          protocolVersion: request.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo,
        })
        break
      case 'tools/list':
        result(request.id, toolList())
        break
      case 'tools/call':
        result(request.id, callTool(request.params))
        break
      case 'ping':
        result(request.id, {})
        break
      default:
        error(request.id, -32601, `Method not found: ${request.method}`)
    }
  } catch (err) {
    error(request.id, -32000, err instanceof Error ? err.message : String(err))
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line))
    } catch (err) {
      process.stderr.write(`Invalid JSON-RPC message: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
})
