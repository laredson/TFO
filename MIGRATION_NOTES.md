# TFO 1.0.0-rc.1 local package

The new package identity is `tfo`, with a separate `tfo-local` catalogue. Its local manifest is `plugins/tfo/.codex-plugin/plugin.json`. `plugin.portable.json` is an export only; do not create a root `plugin.json` for the local install, because that format suppresses the Stop hook on this host.

The former `autoroute-bootstrap` package and its `autoroute-local` catalogue are not modified by this package. Do not rename an existing installation or point the new catalogue at its cache. The runtime must use `TFO_*` data variables and `tfo_*` tools, with `taskflow_chat_start` renamed specifically to `tfo_budgeted_chat_start`. Historical identifiers belong only in this migration explanation and the explicit importer, not as active tool aliases.

To review legacy data, run `node scripts/import-legacy.mjs --source-data-dir <old-data> --target-data-dir <new-tfo-data>` against explicit directories. The importer refuses an existing target, source/target overlap, links and locks, nonterminal or ambiguous runs, held reservations, and invalid settings. It copies validated settings to the new data root and archives every legacy file byte for byte under `migration-archive/legacy-data`. It never copies archived runs into the active `runs` directory or sends their prompts. The source stays in place. Review the resulting archive before any later manual disposition of the old installation.

`node scripts/build-plugin.mjs` generates the bundled runtime and portable manifest. `scripts/install-local.ps1` registers the local catalogue and installs `tfo@tfo-local`. The RC remains subject to live acceptance in Codex Desktop.
