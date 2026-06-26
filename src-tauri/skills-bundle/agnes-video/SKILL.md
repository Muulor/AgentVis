---
name: agnes-video
description: "Create and inspect Agnes-Video async generation tasks for text-to-video, image-to-video, multi-image video, and keyframe animation through the Agnes AI API. Use this skill when a user asks to generate or monitor AI videos with Agnes/Agnes-Video, when a development workflow needs to call Agnes video APIs, or when an agent should turn text prompts, public image URLs, or keyframes into a video task. This skill reuses the existing AgentVis Agnes API key credential and avoids exposing secrets."
triggers: [agnes-video, Agnes Video, Agnes AI video, Agnes视频, 视频生成, 文生视频, 图生视频, 多图视频, 关键帧动画, text-to-video, image-to-video, keyframes]
execution:
  runtime: python
  entry: scripts/agnes_video_entry.py
  timeout: 600
  maxOutput: 131072
  permissions:
    network: true
    networkMode: brokerOnly
    longRunning: true
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
      description: "Action to run: payload, create, status, create-and-wait, or download. Use payload to preview without network or cost."
    - name: prompt
      type: string
      required: false
      description: "Video prompt for payload/create/create-and-wait."
    - name: taskId
      type: string
      required: false
      description: "Legacy Agnes task id for action=status. Prefer videoId when available."
    - name: videoId
      type: string
      required: false
      description: "Agnes video_id for action=status. Preferred by the Agnes Video V2.0 API."
    - name: videoUrl
      type: string
      required: false
      description: "Generated video URL for action=download."
    - name: model
      type: string
      required: false
      description: "Agnes video model id. Defaults to agnes-video-v2.0."
    - name: image
      type: string
      required: false
      description: "Single public HTTPS image URL for image-to-video."
    - name: images
      type: string
      required: false
      description: "Multiple public HTTPS image URLs for multi-image or keyframe video, as JSON array, newline-separated, or comma-separated text."
    - name: mode
      type: string
      required: false
      description: "Generation mode such as ti2vid or keyframes."
    - name: width
      type: number
      required: false
      description: "Video width. Defaults to 1152."
    - name: height
      type: number
      required: false
      description: "Video height. Defaults to 768."
    - name: numFrames
      type: number
      required: false
      description: "Frame count; must be <=441 and satisfy 8n+1. Defaults to 121."
    - name: frameRate
      type: number
      required: false
      description: "FPS from 1 to 60. Defaults to 24."
    - name: numInferenceSteps
      type: number
      required: false
      description: "Optional inference step count."
    - name: seed
      type: number
      required: false
      description: "Optional seed for reproducible generation."
    - name: negativePrompt
      type: string
      required: false
      description: "Negative prompt describing what to avoid."
    - name: pollInterval
      type: number
      required: false
      description: "Seconds between polling checks for create-and-wait. Defaults to 90 to avoid excessive status checks."
    - name: maxPollInterval
      type: number
      required: false
      description: "Maximum adaptive polling interval in seconds when progress is slow or unchanged. Defaults to 180."
    - name: timeoutSeconds
      type: number
      required: false
      description: "Maximum wait time for create-and-wait. Defaults to 540; use status for longer tasks."
    - name: download
      type: boolean
      required: false
      description: "Explicitly download the completed video to savePath or the AgentVis deliverable directory. For action=status or action=create-and-wait, completed videos are saved by default unless skipDownload=true."
    - name: skipDownload
      type: boolean
      required: false
      description: "Set true only when the user explicitly wants just the task status or video URL without saving the completed video."
    - name: savePath
      type: string
      required: false
      description: "Optional output .mp4 path. Relative paths are saved under the AgentVis workdir/deliverable directory. Passing savePath implies download."
    - name: outputFormat
      type: string
      required: false
      description: "Output format: text or json. Defaults to text."
dependencies:
  python: ">=3.11"
  packages: []
---

# Agnes Video Skill for AgentVis

Create and monitor Agnes AI video generation tasks with no third-party Python dependencies. The script always uses AgentVis `brokerOnly` networking with `credentialRef=agnes`; it never reads API keys from environment variables, Home/AppData files, or Windows Credential Manager directly.

## Actions

- `payload`: validate inputs and print the request body without sending a network request. Use this before costly video calls.
- `create`: submit an Agnes video task and return the task id, video id, status, progress, and raw response.
- `status`: fetch a task by `videoId` through the recommended Agnes result endpoint, or by legacy `taskId`; when complete, return the video URL fields and save the MP4 by default unless `skipDownload=true`.
- `create-and-wait`: submit a task and poll until `completed`, `failed`, or timeout, then save the MP4 by default unless `skipDownload=true`.
- `download`: save a known `videoUrl` to `savePath` or the AgentVis deliverable directory.

## Usage Guidance

Use `payload` first when prompt or frame settings are uncertain. Video generation may consume free quota, queue capacity, or account limits; current pricing and free-use policy should follow the user's Agnes account/docs page. Do not call `create` or `create-and-wait` just to test wiring unless the user has approved generating a real video.

Use `image` for one public HTTPS source image. Use `images` for multi-image guidance or keyframes; pass a JSON array when possible. If `mode=keyframes` is set, provide at least two image URLs; the script places them under `extra_body.image` and adds `extra_body.mode=keyframes`.

Default settings are `model=agnes-video-v2.0`, `width=1152`, `height=768`, `numFrames=121`, and `frameRate=24`. `numFrames` must be less than or equal to 441 and match `8n+1`.

This skill declares `permissions.longRunning=true` and a 600-second script timeout for video polling. `create-and-wait` is bounded to 540 seconds to leave process cleanup margin. It polls every 90 seconds by default and grows the interval up to 180 seconds when status remains queued or progress does not advance. For longer renders, use `create` once and call `status` later with the returned `videoId` when available, or the legacy `taskId`; `status` will save the completed video by default.

If the Agnes API key is not configured, the tool returns a clear failure observation telling the agent to ask the user to configure the Agnes API key in the AgentVis settings panel. The script process cannot read Windows Credential Manager directly.

## Output Notes

The skill returns the generated video URL when Agnes reports `status=completed`. Agnes Video V2.0 may expose it as `video_url` or `remixed_from_video_id`; both are supported. Completed videos are saved automatically for `status` and `create-and-wait`; use `skipDownload=true` only for URL/status-only checks. Downloads are streamed by AgentVis broker directly to disk, so large MP4 files do not enter the tool observation.
