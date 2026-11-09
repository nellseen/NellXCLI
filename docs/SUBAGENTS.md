# Read-only subagents

The agent can use `delegate_readonly` to ask a bounded worker to inspect the workspace and return findings. Each delegation creates a separate persisted session titled `Read-only subagent`, so its prompt, tool events, and result can be inspected or resumed independently. The worker uses the same configured provider router and project/account health policy as its parent. It is limited to four agent steps, 4,000 task characters, 8,000 returned characters, and two active workers per tool instance. It cannot create another subagent.

## Security and limitations

The worker runs in Plan mode with a registry containing only read tools (workspace file listing/search/read, validated skill reads, and read-only Git status/diff/log). It cannot write files, execute shell commands, launch background tasks, or use MCP. Tool output remains untrusted input. There is no separate OS process or sandbox; the read-only policy is enforced by NellXCLI's runtime and tool registry. Subagent model requests share the parent's configured provider projects and quota; this is not a quota failover mechanism. Delegation is sequential in the current agent loop; the concurrency cap protects direct concurrent invocations.
