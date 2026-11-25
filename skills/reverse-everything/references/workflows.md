# Workflows

- Website: authorize URL → analyze web → inspect DOM/network/screenshot evidence → review limitations.
- Software: authorize local file → analyze file → inspect format/import/string/SBOM evidence → never execute the sample.
- Security: passive checks and static rules only → review candidate findings → reproduce in an approved scope.
- Game: upload a legally obtained replay trace → inspect protocol fields/transitions → run generated compatibility service tests.
- USB hardware: `hardware doctor` → optionally `hardware list`/`hardware serial` for OS-visible identities → upload an authorized PCAP/PCAPNG/usbmon/HID descriptor → create `hardware` task → inspect timeline/descriptor evidence. Never open a device or start live capture.
- Firmware: `firmware inspect <path> --authorized` → inspect entropy/layout/strings/components/SBOM/risk candidates → keep unknown or encrypted content UNKNOWN. Never execute, mount or flash the image.
- Development board: identify board and list serial ports → read only user-approved logs in an explicitly authorized local workflow → analyze user-provided firmware offline. Do not reset the board or change control lines.
- Report: export Markdown/SARIF/manifest → verify SHA-256 → cite evidence IDs.
