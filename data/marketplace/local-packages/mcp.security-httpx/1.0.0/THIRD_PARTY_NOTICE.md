# Third Party Notice

This package includes `server.py` adapted from:

- Repository: https://github.com/f1tz/mcp-for-security-python
- Component: `httpx-mcp/server.py`
- Observed commit during packaging: `a4f7ec4`
- Upstream license: MIT

The package is included as a marketplace integration test resource. Installing it registers an MCP server command, but Miko does not execute the security tool during marketplace tests.
