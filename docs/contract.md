# VesselTwin integrations contract

The pairing and credential surface is documented in [platform-handoff.md](platform-handoff.md). The plugin talks to the VesselTwin integrations platform:

- `POST /v1/integrations/pairing/start` and `/pairing/token` (RFC 8628 device flow), implemented here.
- `GET /v1/integrations/status`, `POST /v1/integrations/credential/rotate`: not yet used by the plugin.
- Ingest routes (`/v1/integrations/signalk/readings`): **not built server-side yet**; the plugin does not call them.

Every request carries `X-VesselTwin-Contract: 1` and a `User-Agent`. The JSON Schema for ingest
will be published as a release artifact with milestone M2 and vendored here; CI will validate
fixtures against it.
