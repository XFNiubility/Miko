#!/usr/bin/env node

const serverInfo = { name: 'marketplace-context', version: '1.0.0' }

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function profileArg() {
  const index = process.argv.indexOf('--profile')
  return index >= 0 ? process.argv[index + 1] : 'default'
}

function tools() {
  return {
    tools: [
      {
        name: 'marketplace_context',
        description: 'Return local marketplace MCP context for diagnostics.',
        inputSchema: {
          type: 'object',
          properties: {
            includeEnv: { type: 'boolean', description: 'Include non-sensitive demo env values.' },
          },
        },
      },
    ],
  }
}

function context(args) {
  const payload = {
    label: process.env.MARKETPLACE_CONTEXT_LABEL || 'Marketplace Context',
    mode: process.env.MARKETPLACE_CONTEXT_MODE || 'default',
    profile: profileArg(),
    cwd: process.cwd(),
    node: process.version,
  }
  if (!args?.includeEnv) {
    delete payload.mode
  }
  return payload
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
        result(request.id, tools())
        break
      case 'tools/call':
        if (request.params?.name !== 'marketplace_context') throw new Error(`Unknown tool: ${request.params?.name}`)
        result(request.id, {
          content: [{ type: 'text', text: JSON.stringify(context(request.params?.arguments), null, 2) }],
        })
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
