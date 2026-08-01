# security-httpx MCP

Real-world MCP package based on `f1tz/mcp-for-security-python/httpx-mcp`.

Install behavior:

- Copies this package into `data/marketplace/packages/mcp.security-httpx/1.0.0`.
- Adds the `security_httpx` stdio MCP server to `data/mcp.json`.
- Shows `python`, `${PACKAGE_DIR}/server.py`, `httpx`, and environment keys in the install confirmation preview.

Runtime requirements:

- Python 3.8+
- `fastmcp`
- `httpx` security CLI available on PATH

Do not run this MCP against systems you are not authorized to test.
