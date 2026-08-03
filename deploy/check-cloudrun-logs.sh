#!/bin/bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="hermes-report"' \
  --limit=30 --freshness=1h --format='value(timestamp,textPayload)' --project=furever-dock-hermes-agent
