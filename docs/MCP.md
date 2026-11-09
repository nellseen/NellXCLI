# MCP client

NellXCLI supports local stdio MCP servers configured in `.nellx/mcp.json`:

```json
{
  "servers": {
    "workspace_docs": {
      "command": "node",
      "args": ["./tools/docs-mcp-server.mjs"]
    }
  }
}
```

Use `mcp_list_tools` to discover a configured server's tools, then `mcp_call_tool` to invoke one. Both operations require user approval; every call is approved independently. NellXCLI starts the configured process only after approval and closes it after the request. Configuration supports at most eight servers and 64 arguments per server. Each response is bounded; MCP results are redacted before they enter session history.

## Security and limits

An MCP server is an arbitrary local program. Review its command, arguments, source, and effects before approving. Configuration is workspace-local and can be modified by project content, so it is not a trust signal. Normal mode and Auto mode both require approval for MCP process launch and each tool call. Plan mode cannot launch or call MCP tools. The client uses stdio only; remote transports, OAuth, secret injection, resource subscriptions, and persistent server sessions are not implemented. Do not put API keys or other secrets in this JSON file. Server process environment is limited by the MCP SDK's safe inherited environment defaults; no config-file environment overrides are accepted.

Remote tool descriptions, schemas, and results are untrusted. Arguments are checked against the server-advertised JSON Schema and again by the server. A compromised server can still return deceptive instructions or perform effects permitted to its OS process. NellXCLI does not sandbox that process.
