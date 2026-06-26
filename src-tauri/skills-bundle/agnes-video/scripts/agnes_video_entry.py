"""Script-mode wrapper for the Agnes video skill."""

from __future__ import annotations

import argparse
import sys

import agnes_video


def optional_positive_int(value: int | None, default: int) -> int:
    if value is None or value <= 0:
        return default
    return value


def optional_positive_float(value: float | None, default: float) -> float:
    if value is None or value <= 0:
        return default
    return value


def build_argv(args: argparse.Namespace) -> list[str]:
    action = args.action.strip().lower()
    output_format = (args.output_format or "text").strip().lower()
    if output_format not in {"text", "json"}:
        raise ValueError("outputFormat must be text or json")
    if action not in {"payload", "create", "status", "create-and-wait", "download"}:
        raise ValueError("Unsupported action. Use payload, create, status, create-and-wait, or download.")

    argv = [
        "agnes_video.py",
        action,
        "--output-format",
        output_format,
    ]

    if args.model.strip() and action != "download":
        argv.extend(["--model", args.model.strip()])
    if args.prompt.strip():
        argv.extend(["--prompt", args.prompt.strip()])
    if args.task_id.strip():
        argv.extend(["--task-id", args.task_id.strip()])
    if args.video_id.strip():
        argv.extend(["--video-id", args.video_id.strip()])
    if args.video_url.strip():
        argv.extend(["--video-url", args.video_url.strip()])
    if args.image.strip():
        argv.extend(["--image", args.image.strip()])
    if args.images.strip():
        argv.extend(["--images", args.images.strip()])
    if args.mode.strip():
        argv.extend(["--mode", args.mode.strip()])
    if args.negative_prompt.strip():
        argv.extend(["--negative-prompt", args.negative_prompt.strip()])
    if args.save_path.strip():
        argv.extend(["--save-path", args.save_path.strip()])
    if args.download:
        argv.append("--download")
    if args.skip_download:
        argv.append("--skip-download")

    for flag, value in [
        ("--width", args.width),
        ("--height", args.height),
        ("--num-frames", args.num_frames),
        ("--frame-rate", args.frame_rate),
        ("--num-inference-steps", args.num_inference_steps),
        ("--seed", args.seed),
    ]:
        if value is not None and value > 0:
            argv.extend([flag, str(value)])

    if args.poll_interval is not None:
        argv.extend([
            "--poll-interval",
            str(optional_positive_float(args.poll_interval, agnes_video.DEFAULT_POLL_INTERVAL_SECONDS)),
        ])
    if args.max_poll_interval is not None:
        argv.extend([
            "--max-poll-interval",
            str(optional_positive_float(args.max_poll_interval, agnes_video.DEFAULT_MAX_POLL_INTERVAL_SECONDS)),
        ])
    if args.timeout_seconds is not None:
        argv.extend([
            "--timeout-seconds",
            str(optional_positive_int(args.timeout_seconds, agnes_video.DEFAULT_WAIT_TIMEOUT_SECONDS)),
        ])

    if action in {"payload", "create", "create-and-wait"} and not args.prompt.strip():
        raise ValueError(f"action={action} requires --prompt")
    if action == "status" and not args.task_id.strip() and not args.video_id.strip():
        raise ValueError("action=status requires --videoId or --taskId")
    if action == "download" and not args.video_url.strip():
        raise ValueError("action=download requires --videoUrl")

    return argv


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentVis Agnes video script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--taskId", "--task-id", dest="task_id", default="")
    parser.add_argument("--videoId", "--video-id", dest="video_id", default="")
    parser.add_argument("--videoUrl", "--video-url", dest="video_url", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--image", default="")
    parser.add_argument("--images", default="")
    parser.add_argument("--mode", default="")
    parser.add_argument("--width", type=int, default=None)
    parser.add_argument("--height", type=int, default=None)
    parser.add_argument("--numFrames", "--num-frames", dest="num_frames", type=int, default=None)
    parser.add_argument("--frameRate", "--frame-rate", dest="frame_rate", type=float, default=None)
    parser.add_argument("--numInferenceSteps", "--num-inference-steps", dest="num_inference_steps", type=int, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--negativePrompt", "--negative-prompt", dest="negative_prompt", default="")
    parser.add_argument("--pollInterval", "--poll-interval", dest="poll_interval", type=float, default=None)
    parser.add_argument("--maxPollInterval", "--max-poll-interval", dest="max_poll_interval", type=float, default=None)
    parser.add_argument("--timeoutSeconds", "--timeout-seconds", dest="timeout_seconds", type=int, default=None)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--skipDownload", "--skip-download", dest="skip_download", action="store_true")
    parser.add_argument("--savePath", "--save-path", dest="save_path", default="")
    parser.add_argument("--outputFormat", "--output-format", dest="output_format", default="text")
    args = parser.parse_args()

    try:
        sys.argv = build_argv(args)
    except ValueError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 2

    return agnes_video.main()


if __name__ == "__main__":
    sys.exit(main())
