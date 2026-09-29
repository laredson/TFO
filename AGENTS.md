# TFO repository instructions

TFO is a conventional scheduler. The conversational AI plans tasks and evaluates model/effort; the runtime enforces dependencies, limits and receipt checks. Never represent estimates as measured savings.

Read README.md, docs/PARALLEL_CODEX.md and docs/RELEASE_READINESS.md before changing orchestration. Inspect Git status and preserve unrelated work.

Canonical code lives in runtime/. plugins/tfo/runtime/ is generated with node scripts/build-plugin.mjs. Keep local .codex-plugin/plugin.json and the separate portable export consistent. A root plugin.json belongs only in the portable archive: it changes hook discovery on the current local host.

Run node --test runtime/tests/*.test.mjs scripts/tests/*.test.mjs for release validation. Test intervention, incorrect selection, uncertain delivery and duplicate attempts; fixtures do not establish live Desktop compatibility.

Every orchestrated turn, including the main chat, needs a task-based model/effort decision within user authorization. Verify actual host receipts. Never silently inherit another selection, retry an uncertain send, open a second App Server writer, or change hook trust to make a test pass.

Before promotion, preserve the previous runnable package and data. Install through the supported plugin CLI; use a new chat to load changed skills/tools. Publish, push and tag only with user authorization. Exclude private rollout histories, credentials, machine paths and validation state from archives.
