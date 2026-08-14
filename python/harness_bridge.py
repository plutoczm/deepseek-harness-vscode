#!/usr/bin/env python3
"""Thin JSON-lines bridge between VS Code and the official DeepSeek Harness Python SDK."""

from __future__ import annotations

import json
import os
import sys
import traceback
from importlib.metadata import PackageNotFoundError, version
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def notification_payload(notification: Any) -> dict[str, Any]:
    return {
        "method": getattr(notification, "method", "unknown"),
        "params": getattr(notification, "params", None),
    }


def sdk_version() -> str | None:
    try:
        return version("deepseek-harness-sdk")
    except PackageNotFoundError:
        return None


def main() -> int:
    try:
        from deepseek_harness import DeepSeekHarness
    except Exception as exc:
        emit(
            {
                "type": "error",
                "message": (
                    "DeepSeek Harness SDK is not available in the configured Python environment. "
                    "Run ‘DeepSeek Harness: Install/Upgrade Runtime’ or change deepseekHarness.pythonPath. "
                    f"Original error: {exc}"
                ),
                "traceback": traceback.format_exc(),
            }
        )
        return 2

    cwd = os.path.abspath(os.environ.get("DSH_VSCODE_CWD") or os.getcwd())
    session_root = os.path.abspath(
        os.environ.get("DSH_VSCODE_SESSION_ROOT") or os.path.join(cwd, ".dsh-vscode-sessions")
    )
    os.makedirs(session_root, exist_ok=True)

    model = os.environ.get("DSH_VSCODE_MODEL", "deepseek-v4-pro")
    max_tokens = int(os.environ.get("DSH_VSCODE_MAX_TOKENS", "49152"))

    harness = DeepSeekHarness(
        provider="deepseek-official",
        model=model,
        max_tokens=max_tokens,
        cwd=cwd,
        session_root=session_root,
    )

    emit({"type": "ready", "model": model, "cwd": cwd, "sdkVersion": sdk_version()})

    try:
        for raw_line in sys.stdin:
            raw_line = raw_line.strip()
            if not raw_line:
                continue

            request_id: str | None = None
            try:
                command = json.loads(raw_line)
                command_type = command.get("type")

                if command_type == "shutdown":
                    break

                if command_type != "run":
                    emit({"type": "error", "message": f"Unknown command: {command_type}"})
                    continue

                request_id = str(command["requestId"])
                session_id = str(command["sessionId"])
                prompt = str(command["prompt"])

                def on_notification(notification: Any) -> None:
                    emit(
                        {
                            "type": "notification",
                            "requestId": request_id,
                            "notification": notification_payload(notification),
                        }
                    )

                session = harness.start_session(session_id)
                result = session.run(prompt, on_notification=on_notification)
                emit(
                    {
                        "type": "result",
                        "requestId": request_id,
                        "sessionId": result.session_id,
                        "finalResponse": result.final_response,
                        "finishReason": result.finish_reason,
                    }
                )
            except Exception as exc:  # Keep the bridge alive after one failed request.
                emit(
                    {
                        "type": "error",
                        "requestId": request_id,
                        "message": str(exc),
                        "traceback": traceback.format_exc(),
                    }
                )
    finally:
        harness.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
