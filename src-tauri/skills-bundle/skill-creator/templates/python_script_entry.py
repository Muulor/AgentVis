# AgentVis Script Skill 入口模板：entry 只解析 argsSchema 并调用核心模块。
"""AgentVis Script Skill thin entrypoint template.

ExternalExecutor maps contract argsSchema fields to CLI flags:
    python scripts/entry.py --resourceId abc --mode info --limit 10

Keep parser option names exactly aligned with argsSchema.name. Do not parse
Script Skill arguments as positional sys.argv[1], sys.argv[2].

For brokerOnly Script Skills, keep the declared execution.entry thin. Put API
base URL constants, broker helper code, and HTTP response handling in a sibling
module such as script_core.py. The current sandbox scanner inspects the declared
entry file before launch, so this entry file should not contain URL literals or
direct network-client imports.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import script_core


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AgentVis Script Skill entry template")
    parser.add_argument("--resourceId", required=True, help="Resource id from argsSchema.")
    parser.add_argument("--mode", choices=["info", "summary"], default="info")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--includeMetadata", action="store_true")
    return parser


def print_result(result: Any) -> None:
    if isinstance(result, str):
        print(result)
        return
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main() -> int:
    args = build_parser().parse_args()

    try:
        result = script_core.run(
            resource_id=args.resourceId,
            mode=args.mode,
            limit=args.limit,
            include_metadata=args.includeMetadata,
        )
    except script_core.UserCorrectableError as exc:
        print(str(exc))
        return 0
    except Exception as exc:
        print(f"Script Skill failed: {exc}", file=sys.stderr)
        return 1

    print_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
