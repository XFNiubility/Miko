#!/usr/bin/env node

const serverInfo = { name: 'marketplace-math', version: '1.0.0' }

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function tools() {
  return {
    tools: [
      {
        name: 'calculate',
        description: 'Run a basic arithmetic operation.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
            left: { type: 'number' },
            right: { type: 'number' },
          },
          required: ['operation', 'left', 'right'],
        },
      },
    ],
  }
}

function calculate(args) {
  const left = Number(args?.left)
  const right = Number(args?.right)
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error('left and right must be finite numbers')
  }

  let value
  switch (args?.operation) {
    case 'add':
      value = left + right
      break
    case 'subtract':
      value = left - right
      break
    case 'multiply':
      value = left * right
      break
    case 'divide':
      if (right === 0) throw new Error('division by zero')
      value = left / right
      break
    default:
      throw new Error(`Unsupported operation: ${args?.operation}`)
  }

  const precision = Number(process.env.MARKETPLACE_MATH_PRECISION || '4')
  return Number(value.toFixed(Number.isFinite(precision) ? precision : 4))
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
        if (request.params?.name !== 'calculate') throw new Error(`Unknown tool: ${request.params?.name}`)
        result(request.id, {
          content: [{ type: 'text', text: String(calculate(request.params?.arguments)) }],
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
