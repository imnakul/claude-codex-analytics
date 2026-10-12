#!/usr/bin/env python3
"""Optional Claude Code hook collector. Stores metadata, never tool content."""
import datetime
import json
import os
from pathlib import Path
import sys


def main():
    try:
        payload = json.load(sys.stdin)
        event = payload.get("hook_event_name")
        if event not in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
            return
        record = {key: payload[key] for key in
                  ("session_id", "tool_use_id", "tool_name", "hook_event_name", "cwd", "agent_id")
                  if isinstance(payload.get(key), str)}
        if not record.get("session_id") or not record.get("tool_use_id"):
            return
        record["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        claude_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
        log_dir = Path(os.environ.get("CLAUDE_LOG_DIR", str(claude_dir / "analytics-tools")))
        log_dir.mkdir(parents=True, exist_ok=True)
        # One append write, so concurrent hooks do not overwrite each other.
        line = (json.dumps(record, ensure_ascii=True) + "\n").encode("utf-8")
        descriptor = os.open(log_dir / "tools.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, line)
        finally:
            os.close(descriptor)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        # Recording errors must not block Claude's tool execution.
        print("Claude analytics hook could not save metadata: " + type(error).__name__, file=sys.stderr)


if __name__ == "__main__":
    main()
