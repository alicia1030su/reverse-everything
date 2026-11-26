# REST API

Base URL: `http://127.0.0.1:4173/api/v1`. Send `Authorization: Bearer <local-token>`. Legacy `/api` remains compatible. OpenAPI: `/api/openapi.json` or the versioned file listed in the current release.

Hardware routes `/api/hardware/capabilities`, `/doctor`, `/devices` and `/serial` are loopback-only and disabled when remote API mode is enabled. They never open device handles. USB records and firmware use normal project/upload/task routes with adapter `hardware` or `firmware`.

Game Revival routes include `/api/game/profiles`, `/api/projects/{id}/game-profile`, `/api/projects/{id}/game-scan`, `/api/projects/{id}/game-specs`, `/api/game/rebuilds`, `/api/game/rebuilds/{id}` and `/api/game/rebuilds/{id}/archive`. Directory scanning is restricted to absolute paths under the API server's `RE_GAME_ROOTS`; missing configuration or out-of-scope paths return 403, including through HTTP MCP. Generated servers are independent compatibility implementations, not original servers.

Long tasks return a task ID immediately. Poll `/api/tasks/{id}` or subscribe to `/api/tasks/{id}/events`. Errors use `{error:{code,message,requestId}}`.
