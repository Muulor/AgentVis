---
name: generate_image
description: Use this tool when the user needs visual content, website design, UI/UX design, high-quality document illustrations, or image interaction with the agent. The tool calls an advanced AI image model, supports optional reference images, and can control output aspect ratio and image size.
category: tool
---

# generate_image Tool

Generate images from coherent natural-language descriptions with an advanced AI image model.

## When To Use

- Create visual content such as posters, illustrations, photos, banners, thumbnails, and cover images.
- Produce website, UI/UX, presentation, document, or office-file illustrations that improve delivery quality.
- The user explicitly asks to generate, create, edit, modify, restyle, or compose an image.
- The user provides an existing image path and asks for image editing, style transfer, or reference-based generation.
- Multiple images need to be combined into one output, such as merging subjects, transferring style, or blending elements.
- The task involves interaction with the agent's avatar or generating the agent's own visual appearance.

## When Not To Use

- The user asks only to read, inspect, or analyze an image -> use `read`.
- The task is unrelated to image generation or image editing.
- Another user-specified image-generation skill is explicitly required for the task; follow the user's requested skill first.
- Do not call this tool concurrently. A single step should contain at most one `generate_image` call.

## Decision Hint

- Use `behaviorHint='direct'` for ordinary image generation because this is a low-risk assistive tool.
- Write the prompt as natural language. Describe the scene, purpose, composition, lighting, style, and details instead of listing disconnected keywords.
- Preserve the core requirements from the user's request or MB instruction. Optimize wording for image generation without changing intent.
- If the generated image must be referenced later, set `custom_name` during generation. Do not rename the generated file afterward; renaming can break image display in the AgentVis UI.
- Use `ref_image_path` for one local reference image and `ref_image_paths` for multiple local reference images. The two parameters may be combined; the tool merges them automatically.
- Reference image paths must be local file paths. Do not pass temporary `http` or `https` image URLs as reference paths.
- Do not use `4K` unless the user explicitly asks for it. Prefer the default or `1K` for quick drafts.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | Yes | Image generation prompt. Describe the desired image narratively and include useful visual details. |
| `ref_image_path` | string | No | Local path to one reference image for editing, style transfer, or reference-based generation. |
| `ref_image_paths` | string[] | No | Local paths to multiple reference images, up to 14 images, for multi-image composition or style blending. |
| `aspect_ratio` | string | No | Output aspect ratio. Defaults to `1:1` when omitted. |
| `image_size` | string | No | Output image size. Available values: `1K`, `2K`, `4K`. Use uppercase `K`. |
| `custom_name` | string | No | Custom output file name without extension, such as `hero_banner` or `logo_dark`. Use only letters, numbers, underscores, and hyphens. |

Supported aspect ratios:

`1:1`, `1:4`, `1:8`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:4`, `8:1`, `9:16`, `16:9`, `21:9`

Supported image sizes:

`1K`, `2K`, `4K`

`image_size` must use uppercase `K`; lowercase values can be rejected by the image API.

## Prompt Writing Guide

Core principle: describe the scene, not a keyword list. Narrative descriptions usually produce better images than keyword piles.

1. Be specific about visual details. Instead of "premium packaging", describe the material, surface finish, label placement, lighting, and surrounding objects.
2. Provide context and intent. "A minimalist logo concept for a high-end skincare brand" is better than "design a logo".
3. Use visual and photographic terms when useful: wide-angle, macro, close-up, studio lighting, golden hour, low-angle, bird's-eye view, shallow depth of field.
4. For complex scenes, describe the background first, then the main subject, then the details.
5. Use semantic negative prompting. Instead of saying "no cars", describe "an empty, quiet street".
6. If text must appear in the image, specify the exact text and then ask for an image containing that text. Text generation in images can still be imperfect, so keep requested text short.

### Examples

Poor:

`logo, luxury, skincare, simple`

Good:

`A minimalist logo concept for a high-end skincare brand, built around a clean geometric leaf mark and refined sans-serif lettering. The design should feel calm, precise, and premium, with generous spacing, a white background, and subtle warm-gray accents.`

Poor:

`website hero image, technology, futuristic`

Good:

`A full-width hero image for a professional AI workflow dashboard. Show a clean desktop interface floating in a softly lit studio environment, with subtle depth, crisp panels, and a calm productivity-focused mood. Use balanced composition with empty space on the left for headline text.`

## Output And File Handling

- Generated images are saved automatically to the deliverables directory.
- The tool returns saved file paths, not raw image data.
- Do not rename generated image files after generation. Use `custom_name` when a stable name is needed.
- For multi-image composition, describe how the elements from each reference image should be combined.
- The maximum number of reference images is 14.

## Agent Avatar Reference Image

If the task involves generating the agent's own appearance, such as an interaction photo or character image, the working directory may contain an avatar reference image:

```yaml
ref_image_path: "{workdir}/agent_avatar.webp"
```

When using this reference image, describe in the prompt how the target image should be generated from the avatar, including the scene, pose, style, and visual treatment. Prefer quick `1K` generation unless the user asks for a larger image.
