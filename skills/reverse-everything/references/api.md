# REST API

Base URL: `http://127.0.0.1:4173/api/v1`. Send `Authorization: Bearer <local-token>`. Legacy `/api` remains compatible. OpenAPI: `/api/openapi.json` or the versioned file listed in the current release.

Hardware routes `/api/hardware/capabilities`, `/doctor`, `/devices` and `/serial` are loopback-only and disabled when remote API mode is enabled. They never open device handles. USB records and firmware use normal project/upload/task routes with adapter `hardware` or `firmware`.

Legacy Studio uses normal project/upload/task routes with project kind `software` and adapter `legacy`. Optional task options are `path` (must be under API-server `RE_LEGACY_ROOTS`), `recover: true`, and `reconstruction` (`kind`, `name`, `requirements`). The adapter never executes the original program or calls remote AI.

Game Revival routes include `/api/game/profiles`, `/api/projects/{id}/game-profile`, `/api/projects/{id}/game-scan`, `/api/projects/{id}/game-specs`, `/api/game/rebuilds`, `/api/game/rebuilds/{id}` and `/api/game/rebuilds/{id}/archive`. Directory scanning is restricted to absolute paths under the API server's `RE_GAME_ROOTS`; missing configuration or out-of-scope paths return 403, including through HTTP MCP. Generated servers are independent compatibility implementations, not original servers. L0-L7 grades implementation; original-client and protocol compatibility default to UNKNOWN.

Long tasks return a task ID immediately. Poll `/api/tasks/{id}` or subscribe to `/api/tasks/{id}/events`. Errors use `{error:{code,message,requestId}}`.

## Binary Diff

Use `POST /api/binary-diff` with `{beforeTaskId,afterTaskId,beforeArtifact?,afterArtifact?,maxFunctions?,minSimilarity?,maxChanges?}`. Both tasks must be completed and contain verified Program IR artifacts (default `program-ir.json`). The response contains function matches, additions, removals, structural changes, evidence IDs and limitations. Identical task IDs or identical input binary SHA-256 values are rejected. MCP exposes the same operation as `binary_diff`; the CLI command is `binary-diff`.

## Autopilot

Create with `POST /api/autopilot/tasks` and a JSON body `{projectId,prompt,idempotencyKey?,conversationId?,uploadIds?,paths?,urls?}`. `Idempotency-Key` is also accepted as a header and scoped to the project. List with `GET /api/autopilot/tasks?projectId=...&limit=100&offset=0`; inspect with `GET /api/autopilot/tasks/{id}`. Submit answers and explicit approvals with `POST /{id}/answers` `{answers,approveContract?,approvePlan?}`. Pause/resume/cancel use `POST /{id}/{action}`. Read `GET /{id}/messages`, `GET /{id}/artifacts`, download `GET /{id}/artifacts/{name}`, or subscribe to `GET /{id}/events` (SSE, supports `Last-Event-ID`). Downloads are restricted to the managed Autopilot artifact root and are served only after size and SHA-256 verification. `AutopilotError` status/code values are preserved in the standard error envelope.
