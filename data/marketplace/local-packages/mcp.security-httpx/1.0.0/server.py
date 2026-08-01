#!/usr/bin/env python3
"""
Httpx MCP Server
A Model Context Protocol server that provides Httpx functionality for HTTP service discovery and probing.

Adapted from https://github.com/f1tz/mcp-for-security-python/tree/main/httpx-mcp
for Miko marketplace install/preview testing.
"""

import sys
import subprocess
import asyncio
import re
from typing import List, Optional
from mcp.server.fastmcp import FastMCP

if len(sys.argv) < 2:
    print("Usage: python server.py <httpx binary>", file=sys.stderr)
    sys.exit(1)

httpx_command = sys.argv[1]

mcp = FastMCP("httpx", version="1.0.0")


def remove_ansi_codes(text: str) -> str:
    """Remove ANSI color codes from text."""
    ansi_escape = re.compile(r'\x1B\[[0-9;]*m')
    return ansi_escape.sub('', text)


@mcp.tool()
async def httpx(target: List[str], ports: Optional[List[int]] = None, probes: Optional[List[str]] = None) -> str:
    """Scans target domains and detects active HTTP/HTTPS services.

    Args:
        target: Domain names to scan for HTTP and HTTPS services.
        ports: Optional ports to scan.
        probes: Optional httpx probe flags such as status-code, title, tech-detect, ip, asn.

    Returns:
        Results from httpx scan showing active HTTP/HTTPS services.
    """
    try:
        cmd = [httpx_command, "-u", ",".join(target), "-silent"]

        if ports and len(ports) > 0:
            cmd.extend(["-p", ",".join(map(str, ports))])

        if probes and len(probes) > 0:
            for probe in probes:
                cmd.append(f"-{probe}")

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            text=True,
        )

        stdout, _ = await process.communicate()
        clean_output = remove_ansi_codes(stdout)

        if process.returncode == 0 or process.returncode is None:
            return clean_output.strip()
        return f"httpx exited with code {process.returncode}\nOutput:\n{clean_output}"

    except Exception as e:
        return f"Failed to start httpx: {str(e)}"


if __name__ == "__main__":
    mcp.run()
