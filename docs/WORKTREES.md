# Git worktree tools

The agent can create and remove named worktrees at .nellx/worktrees/<name>. Names are restricted to alphanumerics, underscore, and hyphen. Git is launched with an argument array and no shell. Worktree creation and removal are destructive-permission tools and always require approval, including Auto mode. Removal omits Git's force flag, so modified worktrees remain until the user resolves them.

The path resolver verifies the workspace root and rejects symlink escapes. Worktrees are excluded from file indexing to avoid duplicate traversal. A worktree can still contain user data; review the approval summary and Git status before removal. No OS-level sandbox is provided.
