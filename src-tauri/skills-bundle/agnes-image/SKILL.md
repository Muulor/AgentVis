---
name: agnes-image
description: "Generate and edit images with Agnes Image 2.1 Flash through the Agnes AI API. Use this Script Skill for text-to-image, public-URL/Data-URI image-to-image, high-density visual drafts, or as a fallback when the native generate_image tool fails because image provider API keys are missing or the image provider path is hard-blocked. For editing a prior Agnes output, read workdir/agnes-image/latest-url.md or the sidecar .url.md and pass the HTTPS URL as image; do not pass or compress the downloaded local file. This skill reuses the existing AgentVis Agnes API key credential and stores generated image URLs for later edit requests."
triggers: [agnes-image, Agnes Image, Agnes AI image, Agnes图片, Agnes图像, agnes-image-2.1-flash, generate_image fallback, 图像生成备用, 免费生图]
execution:
  runtime: python
  entry: scripts/agnes_image_entry.py
  timeout: 240
  maxOutput: 262144
  permissions:
    network: true
    networkMode: brokerOnly
    filesystem:
      - fromArg: imagePath
        access: readOnly
  credentials:
    - id: agnes
      provider: agnes
      mode: brokerAuth
      hosts: [apihub.agnes-ai.com]
      headerName: Authorization
      headerValuePrefix: "Bearer "
      required: true
  argsSchema:
    - name: action
      type: string
      required: true
      description: "Operation to run. Use payload to preview without network or cost."
      allowedValues: [payload, generate, download-url]
      examples: [payload, generate]
    - name: prompt
      type: string
      required: false
      description: "Image generation or editing prompt for payload/generate."
    - name: model
      type: string
      required: false
      description: "Agnes image model id. Defaults to agnes-image-2.1-flash."
      default: agnes-image-2.1-flash
    - name: size
      type: string
      required: false
      description: "Explicit output size such as 1024x1024 or 1536x864. Takes precedence over aspectRatio/imageSize."
    - name: aspectRatio
      type: string
      required: false
      description: "Output aspect ratio used when size is omitted."
      allowedValues: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"]
      default: "1:1"
    - name: imageSize
      type: string
      required: false
      description: "Size tier used with aspectRatio when size is omitted."
      allowedValues: [1K, 2K, 4K, auto]
      default: 1K
    - name: image
      type: string
      required: false
      description: "Single input image for image-to-image: public HTTPS URL or data:image/*;base64 Data URI. For prior Agnes outputs, pass the URL saved in workdir/agnes-image/latest-url.md or the sidecar .url.md; do not pass the downloaded local file path."
    - name: images
      type: string
      required: false
      description: "Multiple input images as a JSON array, newline-separated, or comma-separated public HTTPS URLs/Data URIs. Prefer generated URLs from .url.md notes for Agnes edits; local file paths are not valid here."
    - name: imagePath
      type: string
      required: false
      description: "Last-resort tiny local input image path converted to a Data URI for image-to-image. The broker request body is limited; do not compress or re-encode a prior Agnes output to fit it. Read latest-url.md or the sidecar .url.md and pass that HTTPS URL via image instead."
    - name: imageUrl
      type: string
      required: false
      description: "Generated image URL to download for action=download-url."
    - name: savePath
      type: string
      required: false
      description: "Optional output image path under the AgentVis workdir. Relative paths are saved under workdir/agnes-image/."
    - name: customName
      type: string
      required: false
      description: "Optional output file name stem using letters, numbers, underscores, and hyphens."
    - name: skipDownload
      type: boolean
      required: false
      description: "Return and record the generated URL without downloading the image. Usually leave false."
    - name: requestTimeout
      type: number
      required: false
      description: "HTTP request timeout in seconds. Defaults to 115 because the broker helper caps per-request waits."
      min: 1
      max: 115
      default: 115
    - name: outputFormat
      type: string
      required: false
      description: "Observation format."
      allowedValues: [text, json]
      default: text
dependencies:
  python: ">=3.11"
  packages: []
---

# Agnes Image Skill for AgentVis

Generate or edit images through Agnes Image 2.1 Flash with no third-party Python dependencies. The script always uses AgentVis `brokerOnly` networking with `credentialRef=agnes`; it never reads API keys from environment variables, Home/AppData files, or Windows Credential Manager directly.

## Troubleshooting

- Prefer the native `generate_image` tool for normal image generation and local-reference editing. Use this Script Skill when the native path cannot run, the user explicitly asks for Agnes Image, or a previous Agnes URL should be edited.
- Use `image` or `images` only for public HTTPS URLs or Data URI inputs. If a tiny local image must be used, pass `imagePath`; the broker request body is limited to about 1MB.
- If the measured `actualSize` is lower than `requestedSize`, report the Agnes provider limitation plainly. Do not upscale or create a derived image file unless the user explicitly asks for upscaling.

## URL Persistence

Every successful URL generation or URL download returns the generated URL in the observation and writes:

- a sidecar Markdown note next to the saved image, such as `my-image.url.md`;
- `workdir/agnes-image/latest-url.md`, overwritten with the newest Agnes image URL.

For a later edit, read `latest-url.md` or the sidecar note and pass that URL as `image` with a new `prompt`.

## Output Notes

The skill returns saved image paths, URL note paths, the generated URL, the requested API size as `requestedSize`, and the downloaded file's measured pixel size as `actualSize`. Agnes may return an image at a different actual resolution than the requested size tier, so report `actualSize` as the real local image resolution. If `skipDownload=true` or download failed, `actualSize` is unknown; do not describe `requestedSize` as the generated image's final resolution. If `actualSize` is smaller than requested, do not auto-upscale unless the user explicitly requests an upscaled derivative. Downloads are streamed by AgentVis broker directly to disk, so large image files do not enter the tool observation.
