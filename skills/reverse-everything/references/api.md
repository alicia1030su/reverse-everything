# REST API

Base URL: `http://127.0.0.1:4173/api/v1`. Send `Authorization: Bearer <local-token>`. Legacy `/api` remains compatible. OpenAPI: `/api/openapi.json` or `docs/api/openapi-v0.0.2.json`.

Long tasks return a task ID immediately. Poll `/api/tasks/{id}` or subscribe to `/api/tasks/{id}/events`. Errors use `{error:{code,message,requestId}}`.
