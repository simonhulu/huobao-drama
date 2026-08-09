# Persistence And Handoff

The final script file contains only teleprompter-ready spoken text. Contracts, source notes, audit records, alternate hooks, titles, and shot ideas remain outside that file.

For a final manuscript:

1. Scan the final body for production-provenance leakage and sentence health according to Step 11 in `SKILL.md`. In transplant mode, `scan-wash-overlap.mjs` remains the literal copy-paste guard anchored to `00-original-source.raw.txt`; any wash violation (exit 1) breaks the handoff early.
2. Persist the clean body through the project tool.
3. If the project uses cheat-on-content, also persist a copy named `scripts/YYYY-MM-DD_<hash>_<short>.md` where `<hash>` is the first 12 characters of the SHA-256 hash of the clean body and `<short>` is a 12–20 character slug from the title promise.
4. Store the contracts and audit evidence under scripts/polish-notes/<article-id>/.
5. Do not overwrite a script after prediction without creating the appropriate revision trail.
6. Run cheat-predict only after the script and its audit record pass.

Optional downstream work such as titles, covers, shots, and video plans belongs to its dedicated skill. It is not a condition for the writing skill to pass.
