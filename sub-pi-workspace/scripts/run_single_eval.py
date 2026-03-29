#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def extract_text(message: dict) -> str:
    parts = []
    for item in message.get("content", []):
        if item.get("type") == "text":
            parts.append(item.get("text", ""))
    return "\n".join(p for p in parts if p).strip()


def parse_result(result_path: Path) -> tuple[str, dict, str, str]:
    final_text = ""
    usage = {}
    provider = ""
    model = ""

    with result_path.open("r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            message = None
            if event.get("type") in {"message_end", "turn_end"}:
                message = event.get("message", {})
            elif event.get("type") == "agent_end":
                messages = event.get("messages", [])
                if messages:
                    message = messages[-1]

            if not message or message.get("role") != "assistant":
                continue

            text = extract_text(message)
            if text:
                final_text = text
            usage = message.get("usage", usage)
            provider = message.get("provider", provider)
            model = message.get("model", model)

    return final_text, usage, provider, model


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--skill-path")
    parser.add_argument("--label", required=True)
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    prompt_file = Path(args.prompt_file).resolve()
    run_dir = Path(args.run_dir).resolve()
    outputs_dir = run_dir / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)

    result_path = run_dir / "result.jsonl"
    stderr_path = run_dir / "stderr.log"
    final_response_path = outputs_dir / "final-response.md"
    timing_path = run_dir / "timing.json"
    status_path = run_dir / "status.json"
    metrics_path = outputs_dir / "metrics.json"

    cmd = [
        "pi",
        "--no-session",
        "--mode",
        "json",
        "--print",
        "@" + str(prompt_file),
    ]

    if args.skill_path:
        cmd.extend(["--no-skills", "--skill", str(Path(args.skill_path).resolve())])
    else:
        cmd.append("--no-skills")

    start = time.time()
    start_ms = int(start * 1000)
    with result_path.open("w", encoding="utf-8") as stdout_f, stderr_path.open("w", encoding="utf-8") as stderr_f:
        proc = subprocess.run(
            cmd,
            cwd=str(project_root),
            stdout=stdout_f,
            stderr=stderr_f,
            text=True,
            check=False,
        )
    end = time.time()
    end_ms = int(end * 1000)

    final_text, usage, provider, model = parse_result(result_path)
    final_response_path.write_text(final_text or "", encoding="utf-8")

    total_tokens = usage.get("totalTokens", 0)
    timing = {
        "total_tokens": total_tokens,
        "duration_ms": end_ms - start_ms,
        "total_duration_seconds": round(end - start, 3),
        "provider": provider,
        "model": model,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "return_code": proc.returncode,
    }
    timing_path.write_text(json.dumps(timing, ensure_ascii=False, indent=2), encoding="utf-8")

    metrics = {
        "label": args.label,
        "provider": provider,
        "model": model,
        "total_tokens": total_tokens,
        "output_chars": len(final_text or ""),
        "errors_encountered": 0 if proc.returncode == 0 else 1,
        "files_created": [str(final_response_path)],
    }
    metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")

    status = {
        "success": proc.returncode == 0 and bool(final_text.strip()),
        "label": args.label,
        "return_code": proc.returncode,
        "summaryFile": str(final_response_path),
        "rawResultFile": str(result_path),
        "stderrFile": str(stderr_path),
        "timingFile": str(timing_path),
    }
    status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")

    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
