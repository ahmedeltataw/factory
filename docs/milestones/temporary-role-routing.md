# Temporary role routing

Designer direction, 2026-11-09. These are local operating instructions for the current build work, not an implemented automatic model router or evidence that a model has run.

- **Lead:** Codex coordinates, writes contracts and protected tests, verifies evidence, and integrates reviewed local work. Codex also performs supervisory checks; it is not the designated independent Reviewer.
- **Primary Builders:** Antigravity Gemini 3.8 Flash and the previously authorized OpenCode DeepSeek lane. The verified CLI model IDs for 3.8 are `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, and `gemini-3.8-flash-low`; choose effort appropriate to the task. The Designer selected DeepSeek in place of Gemini 3.1 Pro after that model was absent from the authenticated Antigravity CLI list on 2026-11-09.
- **Builder fallback:** GLM on the previously authorized OpenCode lane, subject to actual availability and quota. Record the real provider/model and any limits; do not silently use a paid or unauthorized model.
- **Independent Reviewer until Claude returns:** Antigravity Gemini 4 Argon, verified IDs `gemini-4-argon-high`, `gemini-4-argon-medium`, and `gemini-4-argon-low`. The Reviewer reviews the diff and evidence independently and records its actual verdict; it does not implement changes. Codex remains responsible for integration and for addressing review findings. Preserve the verification policy's different-family requirements; whether a Gemini Reviewer is sufficiently independent from a Gemini Builder for a particular card must be explicitly assessed against the policy, not assumed.
- **Git boundary:** work locally in separate branches and worktrees. No GitHub upload, merge into `main`, or remote write is authorized. Claude's later review remains pending.

Antigravity CLI authentication and model listing succeeded on the host. This does not establish headless write permission, sandbox enforcement, successful dispatch, or completed review. Record each separately from the policy above. Never pass secrets or client-confidential material to providers not authorized for it.

Availability check on 2026-11-09: Antigravity `gemini-3.8-flash-high` completed a bounded Builder edit. No-tools probes of OpenCode `opencode/deepseek-v4.1-flash-free` and `opencode/glm-5.3-flash-free` returned “Free usage limit reached”; those primary and fallback lanes remain configured in the instructions but cannot be treated as available until a later successful probe. No paid substitution was made.
