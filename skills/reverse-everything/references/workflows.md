# Workflows

- Website: authorize URL → analyze web → inspect DOM/network/screenshot evidence → review limitations.
- Software: authorize local file → analyze file → inspect format/import/string/SBOM evidence → never execute the sample.
- Legacy Studio: authorize software/data → create `legacy` task → inspect read-only profile and compatibility/license diagnostics → optionally recover CSV/DBF/SQLite/INI/JSON/XML or generate an independent INI/CSV/text tool → inspect real tests/startup and hashes. Local paths require API-server `RE_LEGACY_ROOTS`; never execute the original or bypass licenses.
- Security: passive checks and static rules only → review candidate findings → reproduce in an approved scope.
- Game Revival: create a game project and profile → configure API-server `RE_GAME_ROOTS` → read-only incremental scan → inspect file fingerprints and unique V5 behavior IR → create evidence-graded spec → rebuild → inspect implementation level and separate target evidence → download validated ZIP. L0-L7 grade the generated service; original-client and protocol compatibility default to UNKNOWN. v0.0.6 Docker/L7 has official candidate-CI evidence, but commercial original-client compatibility is not guaranteed.
- USB hardware: `hardware doctor` → optionally `hardware list`/`hardware serial` for OS-visible identities → upload an authorized PCAP/PCAPNG/usbmon/HID descriptor → create `hardware` task → inspect timeline/descriptor evidence. Never open a device or start live capture.
- Firmware: `firmware inspect <path> --authorized` → inspect entropy/layout/strings/components/SBOM/risk candidates → keep unknown or encrypted content UNKNOWN. Never execute, mount or flash the image.
- Development board: identify board and list serial ports → read only user-approved logs in an explicitly authorized local workflow → analyze user-provided firmware offline. Do not reset the board or change control lines.
- Report: export Markdown/SARIF/manifest → verify SHA-256 → cite evidence IDs.
