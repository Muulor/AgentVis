---
name: image-batch-processor
description: "A skill for batch processing image files, supporting resizing, format conversion, compression, and renaming. Automatically triggered when the user mentions needs such as processing multiple images, batch scaling, format conversion, image compression, or batch renaming. Use this skill regardless of whether the user says 'compress images', 'resize images', 'convert image formats', or 'batch rename images'. Supports common image formats including JPG/PNG/WEBP/HEIF."
triggers: [image-batch-processor, 批量图片, 批量处理图片, 图片尺寸, 图片压缩, 图片格式转换, 图片重命名, 压缩图片, 调整图片大小, 转换图片格式, 批量缩放, batch process images, image size, image compression, image format conversion, image renaming, compress images, adjust image size, convert image format]
---

# Image Batch Processor skill for AgentVis - Batch Image Processor

Batch process image files in a folder, with support for resizing, format conversion, compression, and renaming.

## Supported Image Formats

JPG/JPEG, PNG, WEBP, HEIF/HEIC

## Core Features

### 1. Batch Resizing

**Scale by ratio**:
```
Original size: 1920x1080 -> scale 50% -> 960x540
```

**By maximum width and height** (preserve aspect ratio):
```
Original size: 1920x1080, max 800x600 -> 800x450
Original size: 1920x1080, max 400x400 -> 400x225
### 2. Batch Format Conversion

Supported formats: JPG, PNG, WEBP, HEIF

- JPG <-> PNG <-> WEBP <-> HEIF bidirectional conversion
### 3. Batch Compression

Control compression level by quality parameter (1-100):
- 1: lowest quality, smallest file
- 100: highest quality, largest file
- Default: 85

### 4. Batch Renaming

Supported naming rules:
- `{n}` - sequence number (001, 002, ...)
- `{n:3}` - sequence number with specified number of digits
- `{name}` - original file name
- `{date}` - date YYYYMMDD
- `{time}` - time HHMMSS
- `{prefix}` - custom prefix

Example: `photo_{n:3}_{date}` -> `photo_001_20260405.jpg`

## Usage

### Intelligent Parsing Mode

The user only needs to describe the requirement, and the system automatically parses the parameters:

```
User: "Help me compress these images"
-> Recognized: compression task, default quality 85

User: "Resize the images to 800x600"
-> Recognized: resize, maximum width and height 800x600

User: "Help me convert the image format to png"
-> Recognized: format conversion, target PNG

User: "Batch rename images and add 2024_ at the front"
-> Recognized: rename, prefix "2024_"
```

### Manual Specification Mode

Explicitly specify through parameters:
```
source: image folder path
output: output folder path
action: resize | convert | compress | rename
scale: 0.5 (by ratio)
max_width: 800
max_height: 600
format: png | jpg | webp
quality: 85
rename_rule: "img_{n:3}"
```

## Execution Flow

### Step 1: Parse User Intent

Identify the operation type and parameters the user wants to execute.

### Step 2: Determine Source Folder

Prefer the path specified by the user, or ask the user.

### Step 3: Generate Processing Command

Call scripts/image_processor.py to execute batch processing.

### Step 4: Return Results

Report the number of successfully processed files and the output path.

## Processing Script Usage

### Basic Usage

```bash
python image_processor.py <source_folder> --action <action> [options]
```

### Parameter Description

| Parameter | Description |
|------|------|
| `--action` | Operation type: resize/convert/compress/rename |
| `--source` | Source folder path |
| `--output` | Output folder path (default: create a new folder under the source folder) |
| `--format` | Target format: jpg/png/webp/heif |
| `--quality` | Compression quality 1-100 |
| `--scale` | Scaling ratio 0.1-10.0 |
| `--max-width` | Maximum width (preserve aspect ratio) |
| `--max-height` | Maximum height (preserve aspect ratio) |
| `--rename-rule` | Renaming rule |

### Examples

```bash
# Compress all images (quality 85)
python image_processor.py "C:\Photos" --action compress --quality 85

# Scale by ratio 50%
python image_processor.py "C:\Photos" --action resize --scale 0.5

# Limit maximum size to 800x600
python image_processor.py "C:\Photos" --action resize --max-width 800 --max-height 600

# Convert to PNG
python image_processor.py "C:\Photos" --action convert --format png

# Rename with sequence numbers
python image_processor.py "C:\Photos" --action rename --rename-rule "img_{n:3}"
```

## Notes

1. **HEIF support**: processing HEIF format requires the pillow-heif library
2. **Output overwrite**: identical file names will overwrite existing files
3. **Batch processing**: it is recommended to test first on a small batch of images
4. **Metadata**: preserve EXIF information during conversion

## Error Handling

- Invalid format -> skip and report
- Corrupted file -> record and continue
- Permission issue -> report and terminate

## Requirements

- Pillow (`pip install Pillow`)
- pillow-heif (`pip install pillow-heif`)
