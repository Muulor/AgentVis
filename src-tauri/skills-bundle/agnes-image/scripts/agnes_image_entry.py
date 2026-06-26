"""Script-mode wrapper for the Agnes image skill."""

from __future__ import annotations

import argparse
import sys

import agnes_image


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AgentVis Agnes image script entry.")
    parser.add_argument("--action", required=True)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--size", default="")
    parser.add_argument("--aspectRatio", "--aspect-ratio", dest="aspect_ratio", default="")
    parser.add_argument("--imageSize", "--image-size", dest="image_size", default="")
    parser.add_argument("--image", default="")
    parser.add_argument("--images", default="")
    parser.add_argument("--imagePath", "--image-path", dest="image_path", default="")
    parser.add_argument("--imageUrl", "--image-url", dest="image_url", default="")
    parser.add_argument("--savePath", "--save-path", dest="save_path", default="")
    parser.add_argument("--customName", "--custom-name", dest="custom_name", default="")
    parser.add_argument("--skipDownload", "--skip-download", dest="skip_download", action="store_true")
    parser.add_argument("--requestTimeout", "--request-timeout", dest="request_timeout", type=float, default=None)
    parser.add_argument("--outputFormat", "--output-format", dest="output_format", default="text")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return agnes_image.run(args)
    except agnes_image.AgnesImageError as error:
        status = f" ({error.status_code})" if error.status_code else ""
        print(f"[!] Agnes image skill failed{status}: {error.message}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"[!] Agnes image skill failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
