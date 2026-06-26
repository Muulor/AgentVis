"""
Image Batch Processor - batch image processing script
Supports: resizing, format conversion, compression, renaming
"""

import os
import sys
import argparse
import re
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Tuple

# Import image processing libraries
try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIF_AVAILABLE = True
except ImportError:
    HEIF_AVAILABLE = False


SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.heif', '.heic', '.HEIC', '.HEIF'}
OUTPUT_FORMATS = {'jpg', 'jpeg', 'png', 'webp', 'heif'}


def get_image_files(folder: str) -> List[Path]:
    """Get all supported image files in the folder."""
    folder_path = Path(folder)
    if not folder_path.exists():
        raise ValueError(f"Folder does not exist: {folder}")
    
    files = []
    for ext in SUPPORTED_EXTENSIONS:
        files.extend(folder_path.glob(f"*{ext}"))
        files.extend(folder_path.glob(f"*{ext.upper()}"))
    
    return sorted(set(files))


def resize_image(
    img: Image.Image,
    scale: Optional[float] = None,
    max_width: Optional[int] = None,
    max_height: Optional[int] = None
) -> Image.Image:
    """Resize the image."""
    orig_width, orig_height = img.size
    
    if scale is not None:
        new_width = int(orig_width * scale)
        new_height = int(orig_height * scale)
    elif max_width is not None or max_height is not None:
        # Calculate the scaling ratio and preserve the aspect ratio
        width_ratio = max_width / orig_width if max_width else float('inf')
        height_ratio = max_height / orig_height if max_height else float('inf')
        ratio = min(width_ratio, height_ratio, 1.0)  # Do not enlarge
        
        new_width = int(orig_width * ratio)
        new_height = int(orig_height * ratio)
    else:
        return img
    
    return img.resize((new_width, new_height), Image.Resampling.LANCZOS)


def convert_format(
    img: Image.Image,
    target_format: str,
    quality: int = 85
) -> Tuple[Image.Image, str]:
    """Convert the image format."""
    target_format = target_format.lower()
    if target_format in ('jpeg', 'jpg'):
        target_format = 'jpeg'
        # JPEG does not support transparency and needs conversion
        if img.mode in ('RGBA', 'LA', 'P', 'I;16'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            if img.mode in ('RGBA', 'LA'):
                background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            else:
                background.paste(img)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')
    elif target_format == 'png':
        target_format = 'PNG'
    elif target_format == 'webp':
        target_format = 'WEBP'
    elif target_format == 'heif':
        target_format = 'HEIF'
        # HEIF does not support transparency and needs conversion
        if img.mode in ('RGBA', 'LA', 'P', 'I;16'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            if img.mode in ('RGBA', 'LA'):
                background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            else:
                background.paste(img)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')
    else:
        raise ValueError(f"Unsupported format: {target_format}")
    
    return img, target_format


def compress_image(
    img: Image.Image,
    format_name: str,
    quality: int = 85
) -> Image.Image:
    """Compress the image (adjust quality)."""
    return img


def generate_new_name(
    original_path: Path,
    rule: str,
    index: int,
    target_format: Optional[str] = None
) -> str:
    """Generate a new file name based on the rule."""
    now = datetime.now()
    
    # Parse the number of digits for the sequence number
    n_match = re.search(r'\{n(?::(\d+))?\}', rule)
    if n_match:
        width = int(n_match.group(1)) if n_match.group(1) else 1
        num_str = str(index).zfill(width)
    else:
        num_str = str(index)
    
    # Replace placeholders in the rule
    new_name = rule
    new_name = new_name.replace('{n}', str(index))
    new_name = new_name.replace(f'{{n:{n_match.group(1) if n_match else ""}}}', num_str) if n_match else new_name
    new_name = re.sub(r'\{n:\d+\}', lambda m: str(index).zfill(int(m.group(0)[3:-1])), new_name)
    new_name = new_name.replace('{name}', original_path.stem)
    new_name = new_name.replace('{date}', now.strftime('%Y%m%d'))
    new_name = new_name.replace('{time}', now.strftime('%H%M%S'))
    new_name = new_name.replace('{prefix}', '')
    
    # Add extension
    ext = target_format if target_format else original_path.suffix.lstrip('.').lower()
    if ext == 'jpeg':
        ext = 'jpg'
    
    return f"{new_name}.{ext}"


def process_images(
    source_folder: str,
    action: str,
    output_folder: Optional[str] = None,
    target_format: Optional[str] = None,
    quality: int = 85,
    scale: Optional[float] = None,
    max_width: Optional[int] = None,
    max_height: Optional[int] = None,
    rename_rule: Optional[str] = None
) -> dict:
    """Batch process images."""
    if not PIL_AVAILABLE:
        raise RuntimeError("PIL (Pillow) is not installed. Please run: pip install pillow")
    
    files = get_image_files(source_folder)
    if not files:
        return {'success': 0, 'failed': 0, 'errors': ['No supported image files found']}
    
    # Determine output folder
    if output_folder:
        output_path = Path(output_folder)
    else:
        output_path = Path(source_folder) / f"output_{action}"
    output_path.mkdir(parents=True, exist_ok=True)
    
    results = {
        'success': 0,
        'failed': 0,
        'skipped': 0,
        'errors': []
    }
    
    for i, file_path in enumerate(files, 1):
        try:
            # Read image
            img = Image.open(file_path)
            
            # Resize
            if action == 'resize':
                img = resize_image(img, scale=scale, max_width=max_width, max_height=max_height)
            
            # Determine output format
            if target_format:
                fmt = target_format.lower()
                if fmt == 'jpg':
                    fmt = 'jpeg'
            elif action == 'convert':
                fmt = target_format.lower() if target_format else file_path.suffix.lstrip('.').lower()
            else:
                fmt = file_path.suffix.lstrip('.').lower()
                if fmt == 'jpeg':
                    fmt = 'jpg'
            
            # Determine output file name
            if action == 'rename' and rename_rule:
                output_name = generate_new_name(file_path, rename_rule, i, fmt)
            else:
                if fmt in OUTPUT_FORMATS:
                    ext = 'jpg' if fmt == 'jpg' else fmt
                    output_name = file_path.stem + f".{ext}"
                else:
                    output_name = file_path.name
            
            output_file = output_path / output_name
            
            # Save image
            save_kwargs = {}
            if fmt in ('jpg', 'jpeg'):
                save_kwargs['format'] = 'JPEG'
                save_kwargs['quality'] = quality
                save_kwargs['optimize'] = True
            elif fmt == 'png':
                save_kwargs['format'] = 'PNG'
                save_kwargs['optimize'] = True
            elif fmt == 'webp':
                save_kwargs['format'] = 'WEBP'
                save_kwargs['quality'] = quality
            elif fmt == 'heif':
                save_kwargs['format'] = 'HEIF'
                save_kwargs['quality'] = quality
            
            # Format conversion processing
            if action == 'convert' and target_format:
                img, _ = convert_format(img, fmt, quality)
            elif action == 'compress':
                # In compression mode, save directly and preserve the original format
                save_kwargs = {}
                orig_fmt = file_path.suffix.lstrip('.').lower()
                if orig_fmt in ('jpg', 'jpeg'):
                    save_kwargs['format'] = 'JPEG'
                    save_kwargs['quality'] = quality
                    save_kwargs['optimize'] = True
                    if img.mode in ('RGBA', 'LA', 'P'):
                        background = Image.new('RGB', img.size, (255, 255, 255))
                        if img.mode == 'P':
                            img = img.convert('RGBA')
                        background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                        img = background
                    elif img.mode != 'RGB':
                        img = img.convert('RGB')
                elif orig_fmt == 'png':
                    save_kwargs['format'] = 'PNG'
                    save_kwargs['optimize'] = True
                elif orig_fmt == 'webp':
                    save_kwargs['format'] = 'WEBP'
                    save_kwargs['quality'] = quality
            
            # Use pillow_heif to save HEIF format
            if fmt == 'heif' and action == 'convert' and target_format:
                heif_file = pillow_heif.from_pillow(img)
                heif_file.save(output_file)
            else:
                img.save(output_file, **save_kwargs)
            results['success'] += 1
            
            print(f"✓ [{i}/{len(files)}] {file_path.name} -> {output_name}")
            
        except Exception as e:
            results['failed'] += 1
            results['errors'].append(f"{file_path.name}: {str(e)}")
            print(f"✗ [{i}/{len(files)}] {file_path.name} - failed: {str(e)}")
    
    return results


def main():
    parser = argparse.ArgumentParser(description='Batch image processing tool')
    parser.add_argument('source', help='Source folder path')
    parser.add_argument('--action', '-a', required=True, 
                        choices=['resize', 'convert', 'compress', 'rename'],
                        help='Operation type')
    parser.add_argument('--output', '-o', help='Output folder path')
    parser.add_argument('--format', '-f', choices=['jpg', 'png', 'webp', 'heif'],
                        help='Target format')
    parser.add_argument('--quality', '-q', type=int, default=85,
                        help='Compression quality (1-100, default 85)')
    parser.add_argument('--scale', '-s', type=float,
                        help='Scaling ratio (for example, 0.5 means 50%%)')
    parser.add_argument('--max-width', type=int, help='Maximum width')
    parser.add_argument('--max-height', type=int, help='Maximum height')
    parser.add_argument('--rename-rule', help='Renaming rule')
    
    args = parser.parse_args()
    
    # Validate parameters
    if args.action == 'resize' and not args.scale and not args.max_width and not args.max_height:
        print("Error: resize operation requires specifying --scale or --max-width/--max-height")
        sys.exit(1)
    
    if args.action == 'convert' and not args.format:
        print("Error: convert operation requires specifying --format")
        sys.exit(1)
    
    if args.action == 'rename' and not args.rename_rule:
        print("Error: rename operation requires specifying --rename-rule")
        sys.exit(1)
    
    # Check HEIF support
    if not HEIF_AVAILABLE:
        print("Tip: pillow-heif is not installed, and HEIF format may not be readable. Installation command: pip install pillow-heif")
    
    # Execute processing
    print(f"\n{'='*50}")
    print(f"Batch Image Processing")
    print(f"{'='*50}")
    print(f"Source folder: {args.source}")
    print(f"Operation type: {args.action}")
    if args.format:
        print(f"Target format: {args.format}")
    if args.quality:
        print(f"Compression quality: {args.quality}")
    if args.scale:
        print(f"Scaling ratio: {args.scale}")
    if args.max_width or args.max_height:
        print(f"Maximum size: {args.max_width or 'original size'} x {args.max_height or 'original size'}")
    if args.rename_rule:
        print(f"Renaming rule: {args.rename_rule}")
    print(f"{'='*50}\n")
    
    results = process_images(
        source_folder=args.source,
        action=args.action,
        output_folder=args.output,
        target_format=args.format,
        quality=args.quality,
        scale=args.scale,
        max_width=args.max_width,
        max_height=args.max_height,
        rename_rule=args.rename_rule
    )
    
    # Output results
    print(f"\n{'='*50}")
    print(f"Processing Complete")
    print(f"{'='*50}")
    print(f"Success: {results['success']}")
    print(f"Failed: {results['failed']}")
    if results['errors']:
        print(f"\nError list:")
        for err in results['errors']:
            print(f"  - {err}")
    print(f"{'='*50}")


if __name__ == '__main__':
    main()
