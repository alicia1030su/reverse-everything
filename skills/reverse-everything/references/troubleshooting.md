# Troubleshooting

- `401`: start the app or set `RE_API_TOKEN`/`RE_DATA_DIR`.
- `ADAPTER_UNAVAILABLE`: install the analysis browser explicitly; offline file/static analysis remains available.
- `RESOURCE_LIMIT`: wait for pressure to clear, reduce task budget or close heavy applications; checkpoints are retained.
- `QUEUE_FULL`: retry later; do not create duplicate tasks.
- MCP HTTP: verify Bearer token, loopback Host/Origin and `/mcp` path.
- Missing report: inspect task status and failed stage logs before retrying.
