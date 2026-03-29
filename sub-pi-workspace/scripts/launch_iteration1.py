#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
from pathlib import Path


def tmux_launch(session_name: str, command: str) -> None:
    env_flags = []
    for key in [
        "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
        "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY",
    ]:
        value = os.environ.get(key)
        if value is not None:
            env_flags.extend(["-e", f"{key}={value}"])

    cmd = ["tmux", "new-session", "-d", *env_flags, "-s", session_name, command]
    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--skill-path", required=True)
    parser.add_argument("--runner", required=True)
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    project_root = str(Path(args.project_root).resolve())
    skill_path = str(Path(args.skill_path).resolve())
    runner = str(Path(args.runner).resolve())

    launched = []
    for item in manifest["evals"]:
        for label, run_dir, skill_arg in [
            ("with-skill", item["with_skill_dir"], f"--skill-path '{skill_path}'"),
            ("without-skill", item["without_skill_dir"], ""),
        ]:
            session_name = f"pi-e{item['id']}-{label}"
            command = (
                f"cd '{project_root}' && "
                f"zsh -c 'source \"$HOME/.zshrc\" && python3 \"{runner}\" "
                f"--project-root \"{project_root}\" "
                f"--prompt-file \"{item['prompt_file']}\" "
                f"--run-dir \"{run_dir}\" "
                f"--label \"{label}\" {skill_arg}'"
            )
            tmux_launch(session_name, command)
            launched.append({"session": session_name, "run_dir": run_dir, "label": label, "eval_id": item["id"]})

    print(json.dumps({"launched": launched}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
