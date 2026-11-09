# Workspace skills

Skills are workspace-managed instructions stored in .nellx/skills/<directory>/SKILL.md. The file starts with YAML-style name and description fields and then contains the skill instructions. NellXCLI validates the metadata, limits each file to 30 KB, and exposes list_skills and read_skill read-only tools to the agent.

Skill content is user-controlled project input. It can influence the requested task, but it cannot grant new tool permissions, bypass Plan/Normal approvals, widen the workspace boundary, or authorize secret disclosure. Tool schemas and permission checks remain in the runtime. Skill directories that resolve outside the workspace are rejected.

Current limitations: only the simple name and description frontmatter subset is supported; there is no global skill catalog, installation command, or cross-session skill management.
