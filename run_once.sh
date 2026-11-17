#!/usr/bin/env bash
set -euo pipefail

# Execute a one-shot news briefing run via Docker Compose using the built dist/main.js entrypoint.
docker compose run --rm news_briefing node dist/main.js
