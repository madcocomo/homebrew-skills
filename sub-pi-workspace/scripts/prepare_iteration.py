#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill-root", required=True)
    parser.add_argument("--workspace-root", required=True)
    parser.add_argument("--iteration", type=int, required=True)
    args = parser.parse_args()

    skill_root = Path(args.skill_root).resolve()
    workspace_root = Path(args.workspace_root).resolve()
    iteration_dir = workspace_root / f"iteration-{args.iteration}"
    evals_path = skill_root / "evals" / "evals.json"
    data = json.loads(evals_path.read_text(encoding="utf-8"))

    iteration_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "skill_name": data["skill_name"],
        "iteration": args.iteration,
        "evals": [],
    }

    for item in data["evals"]:
        eval_id = item["id"]
        slug = {
            1: "serial-acorn-avia-base",
            2: "parallel-controller-review",
            3: "mixed-api-refactor",
            4: "unsafe-parallel-shared-scope",
            5: "isolated-debug-loop",
        }.get(eval_id, f"eval-{eval_id}")
        eval_dir = iteration_dir / f"eval-{eval_id}-{slug}"
        eval_dir.mkdir(parents=True, exist_ok=True)
        (eval_dir / "with_skill" / "outputs").mkdir(parents=True, exist_ok=True)
        (eval_dir / "without_skill" / "outputs").mkdir(parents=True, exist_ok=True)

        prompt_path = eval_dir / "prompt.md"
        prompt_path.write_text(item["prompt"], encoding="utf-8")

        metadata = {
            "eval_id": eval_id,
            "eval_name": slug,
            "prompt": item["prompt"],
            "assertions": item.get("expectations", []),
        }
        (eval_dir / "eval_metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        manifest["evals"].append(
            {
                "id": eval_id,
                "name": slug,
                "dir": str(eval_dir),
                "prompt_file": str(prompt_path),
                "with_skill_dir": str(eval_dir / "with_skill"),
                "without_skill_dir": str(eval_dir / "without_skill"),
            }
        )

    (iteration_dir / "run-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
