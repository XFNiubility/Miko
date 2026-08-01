# Local Toolkit MCP

This package installs two local stdio MCP servers:

- `marketplace_math`: exposes a simple calculator tool.
- `marketplace_context`: exposes a local context summary tool.

This package validates the complex MCP path: one marketplace resource writes multiple server entries into `data/mcp.json` while preserving existing user servers.
