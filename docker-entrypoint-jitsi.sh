#!/bin/sh
# Jitsi entrypoint wrapper for NET Kenya Virtual Classroom.
# If JWT_APP_SECRET is provided (Railway env), enable token-based JWT auth so that
# staff JWT tokens grant moderator rights. Otherwise keep guest-only access so the
# existing password-room behaviour keeps working.
if [ -n "$JWT_APP_SECRET" ]; then
  export ENABLE_AUTH=1
  export AUTH_TYPE=token
  export JWT_APP_ID="${JWT_APP_ID:-netkenya}"
fi
export ENABLE_GUESTS=1
exec /init
