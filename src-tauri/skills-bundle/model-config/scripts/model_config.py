"""
model_config.py — AgentVis model configuration management script

Features:
- list_providers: List all built-in providers
- list_models:    List models under the specified provider (built-in + user-defined)
- add_model:      Add a user-defined custom model; fails if the model already exists
- edit_model:     Edit an existing user-defined custom model
- remove_model:   Remove a user-defined custom model

Configuration file format (model-config.json):
{
    "version": 1,
    "models": [
        {
            "id": "model-id",
            "name": "Display Name",
            "providerId": "provider-id",
            "contextWindow": 128000,
            "supportsVision": true
        }
    ]
}
"""

import argparse
import json
import os
import sys
from typing import Optional, TypedDict

# The default Windows console encoding may not support Unicode; force UTF-8
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
if sys.stderr.encoding != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]


# ============================================================================
# Built-in data (kept in sync with frontend modelRegistry.ts)
# ============================================================================

# Built-in provider list (corresponds to the match branches in Rust llm.rs)
BUILTIN_PROVIDERS: list[dict[str, str]] = [
    {"id": "openai", "name": "OpenAI", "protocol": "openai"},
    {"id": "anthropic", "name": "Anthropic", "protocol": "anthropic"},
    {"id": "gemini", "name": "Google AI", "protocol": "gemini"},
    {"id": "zhipu", "name": "ZhipuAI", "protocol": "openai"},
    {"id": "deepseek", "name": "DeepSeek", "protocol": "openai"},
    {"id": "agnes", "name": "Agnes AI", "protocol": "openai"},
    {"id": "stepfun", "name": "StepFun (Step Plan)", "protocol": "openai"},
    {"id": "xiaomi-mimo", "name": "Xiaomi(Token Plan)", "protocol": "openai"},
    {"id": "zhipu-coding", "name": "ZhipuAI (Coding Plan)", "protocol": "openai"},
    {"id": "minimax", "name": "MiniMax(Token Plan)", "protocol": "anthropic"},
    {"id": "volcengine", "name": "Volcengine (Coding Plan)", "protocol": "openai"},
    {"id": "openrouter", "name": "OpenRouter", "protocol": "openai"},
    {"id": "local", "name": "Local", "protocol": "gemini"},
]

# Built-in model list (static snapshot, only used for list_models display)
BUILTIN_MODELS: list[dict] = [
    # OpenAI
    {"id": "gpt-5.4", "name": "GPT-5.4", "providerId": "openai", "contextWindow": 1050000, "supportsVision": True},
    {"id": "gpt-5.4-mini", "name": "GPT-5.4-Mini", "providerId": "openai", "contextWindow": 400000, "supportsVision": True},
    {"id": "gpt-5.4-nano", "name": "GPT-5.4-Nano", "providerId": "openai", "contextWindow": 400000, "supportsVision": True},
    {"id": "gpt-5.5", "name": "GPT-5.5", "providerId": "openai", "contextWindow": 1050000, "supportsVision": True},
    {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "providerId": "openai", "contextWindow": 1050000, "supportsVision": True},
    {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "providerId": "openai", "contextWindow": 1050000, "supportsVision": True},
    {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "providerId": "openai", "contextWindow": 1050000, "supportsVision": True},
    # Anthropic
    {"id": "claude-sonnet-4-6", "name": "Claude-4.6-Sonnet", "providerId": "anthropic", "contextWindow": 200000, "supportsVision": True},
    {"id": "claude-sonnet-5", "name": "Claude-5-Sonnet", "providerId": "anthropic", "contextWindow": 1000000, "supportsVision": True},
    {"id": "claude-opus-4-7", "name": "Claude-4.7-Opus", "providerId": "anthropic", "contextWindow": 200000, "supportsVision": True},
    {"id": "claude-opus-4-8", "name": "Claude-4.8-Opus", "providerId": "anthropic", "contextWindow": 1000000, "supportsVision": True},
    {"id": "claude-fable-5", "name": "Claude-5-Fable", "providerId": "anthropic", "contextWindow": 1000000, "supportsVision": True},
    # Gemini
    {"id": "gemini-3-flash-preview", "name": "Gemini-3-Flash", "providerId": "gemini", "contextWindow": 200000, "supportsVision": True},
    {"id": "gemini-3.1-pro-preview", "name": "Gemini-3.1-Pro", "providerId": "gemini", "contextWindow": 200000, "supportsVision": True},
    {"id": "gemini-3.5-flash", "name": "Gemini-3.5-Flash", "providerId": "gemini", "contextWindow": 1000000, "supportsVision": True},
    # ZhipuAI
    {"id": "glm-4.6v-flash", "name": "GLM-4.6V-Flash", "providerId": "zhipu", "contextWindow": 128000, "supportsVision": True},
    {"id": "glm-5.1", "name": "GLM-5.1", "providerId": "zhipu", "contextWindow": 204800, "supportsVision": False},
    {"id": "glm-5.2", "name": "GLM-5.2", "providerId": "zhipu", "contextWindow": 1000000, "supportsVision": False},
    # DeepSeek (official API, OpenAI-compatible protocol, supports thinking mode)
    {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "providerId": "deepseek", "contextWindow": 1000000, "supportsVision": False},
    {"id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "providerId": "deepseek", "contextWindow": 1000000, "supportsVision": False},
    # Agnes AI (OpenAI-compatible protocol)
    {"id": "agnes-2.0-flash", "name": "Agnes 2.0 Flash", "providerId": "agnes", "contextWindow": 512000, "supportsVision": False},
    # StepFun Step Plan (OpenAI-compatible protocol)
    {"id": "step-3.7-flash", "name": "Step 3.7 Flash", "providerId": "stepfun", "contextWindow": 256000, "supportsVision": True},
    # Xiaomi MiMo (Token Plan API, OpenAI-compatible protocol)
    {"id": "mimo-v2.5", "name": "MiMo V2.5", "providerId": "xiaomi-mimo", "contextWindow": 1000000, "supportsVision": True},
    {"id": "mimo-v2.5-pro", "name": "MiMo V2.5 Pro", "providerId": "xiaomi-mimo", "contextWindow": 1000000, "supportsVision": False},
    # ZhipuAI Coding Plan (dedicated endpoint, independent quota from the coding package)
    # GLM-5.1 requires a higher-level package permission; GLM-4.7 is the recommended main model available in most packages
    {"id": "GLM-4.7", "name": "GLM-4.7 (Coding)", "providerId": "zhipu-coding", "contextWindow": 128000, "supportsVision": True},
    {"id": "GLM-5-Turbo", "name": "GLM-5-Turbo (Coding)", "providerId": "zhipu-coding", "contextWindow": 200000, "supportsVision": True},
    {"id": "GLM-5.1", "name": "GLM-5.1 (Coding)", "providerId": "zhipu-coding", "contextWindow": 204800, "supportsVision": False},
    {"id": "GLM-5.2", "name": "GLM-5.2 (Coding)", "providerId": "zhipu-coding", "contextWindow": 1000000, "supportsVision": False},
    # MiniMax
    {"id": "MiniMax-M2.7", "name": "MiniMax M2.7", "providerId": "minimax", "contextWindow": 204800, "supportsVision": False},
    {"id": "MiniMax-M2.7-highspeed", "name": "MiniMax M2.7 Highspeed", "providerId": "minimax", "contextWindow": 204800, "supportsVision": False},
    {"id": "MiniMax-M3", "name": "MiniMax M3", "providerId": "minimax", "contextWindow": 1000000, "supportsVision": True},
    # Volcengine
    {"id": "doubao-seed-2.0-pro", "name": "Doubao Seed 2.0 Pro", "providerId": "volcengine", "contextWindow": 256000, "supportsVision": True},
    {"id": "doubao-seed-2.0-code", "name": "Doubao Seed 2.0 Code", "providerId": "volcengine", "contextWindow": 256000, "supportsVision": True},
    {"id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "providerId": "volcengine", "contextWindow": 1000000, "supportsVision": False},
    {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "providerId": "volcengine", "contextWindow": 1000000, "supportsVision": False},
    {"id": "kimi-k2.6", "name": "Kimi K2.6", "providerId": "volcengine", "contextWindow": 256000, "supportsVision": True},
    {"id": "Kimi-K2.7-Code", "name": "Kimi K2.7 Code", "providerId": "volcengine", "contextWindow": 256000, "supportsVision": True},
    {"id": "MiniMax-M3", "name": "MiniMax M3", "providerId": "volcengine", "contextWindow": 512000, "supportsVision": False},
    {"id": "glm-5.2", "name": "GLM-5.2", "providerId": "volcengine", "contextWindow": 1000000, "supportsVision": False},
    # OpenRouter (routes to free models from various providers through an OpenAI-compatible protocol)
    # Context windows have been converted to tokens: 262K→262144, 131K→131072, 196K→196608
    {"id": "xiaomi/mimo-v2.5", "name": "Mimo V2.5", "providerId": "openrouter", "contextWindow": 1000000, "supportsVision": True},
    {"id": "xiaomi/mimo-v2.5-pro", "name": "Mimo V2.5 Pro", "providerId": "openrouter", "contextWindow": 1000000, "supportsVision": False},
    {"id": "deepseek/deepseek-v4-flash", "name": "Deepseek V4 Flash", "providerId": "openrouter", "contextWindow": 1000000, "supportsVision": False},
    {"id": "deepseek/deepseek-v4-pro", "name": "Deepseek V4 Pro", "providerId": "openrouter", "contextWindow": 1000000, "supportsVision": False},
    {"id": "minimax/minimax-m3", "name": "Minimax M3", "providerId": "openrouter", "contextWindow": 1000000, "supportsVision": True},
    {"id": "stepfun/step-3.7-flash", "name": "Step 3.7 Flash", "providerId": "openrouter", "contextWindow": 256000, "supportsVision": True},
    {"id": "z-ai/glm-5.2", "name": "GLM 5.2", "providerId": "openrouter", "contextWindow": 1000000, "supportsVision": False},
    {"id": "moonshotai/kimi-k3", "name": "Kimi K3", "providerId": "openrouter", "contextWindow": 1000000, "supportsVision": True},
    # Local
    {"id": "gpt-5.4", "name": "GPT-5.4", "providerId": "local", "contextWindow": 400000, "supportsVision": True},
    {"id": "gpt-5.5", "name": "GPT-5.5", "providerId": "local", "contextWindow": 400000, "supportsVision": True},
    {"id": "gemini-3.5-flash", "name": "Gemini-3.5-Flash", "providerId": "local", "contextWindow": 1000000, "supportsVision": True},
]

VALID_PROVIDER_IDS: set[str] = {p["id"] for p in BUILTIN_PROVIDERS}

CONFIG_FILE_NAME = "model-config.json"
CONFIG_VERSION = 1


# ============================================================================
# Configuration file reading/writing
# ============================================================================

class ModelConfig(TypedDict):
    version: int
    models: list[dict]


def get_config_path(app_data_dir: str) -> str:
    """Get the full configuration file path."""
    return os.path.join(app_data_dir, CONFIG_FILE_NAME)


def load_config(app_data_dir: str) -> ModelConfig:
    """Read user-defined model configuration, returning an empty configuration when the file does not exist."""
    config_path = get_config_path(app_data_dir)
    if not os.path.exists(config_path):
        return {"version": CONFIG_VERSION, "models": []}

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Basic validation
        if data.get("version") != CONFIG_VERSION or not isinstance(data.get("models"), list):
            print("⚠️ Configuration file format does not match; using an empty configuration", file=sys.stderr)
            return {"version": CONFIG_VERSION, "models": []}
        return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"⚠️ Failed to read configuration file: {e}", file=sys.stderr)
        return {"version": CONFIG_VERSION, "models": []}


def save_config(app_data_dir: str, config: ModelConfig) -> None:
    """Save user-defined model configuration."""
    config_path = get_config_path(app_data_dir)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)


def parse_bool(value: Optional[str]) -> bool:
    """Parse a CLI boolean value."""
    if value is None:
        return True
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected one of: true/false, yes/no, 1/0")


def same_model_key(model: dict, model_id: str, provider_id: str) -> bool:
    """Return whether a model dict matches a provider + model id."""
    return model.get("id") == model_id and model.get("providerId") == provider_id


def find_model(models: list[dict], model_id: str, provider_id: str) -> Optional[dict]:
    """Find a model by provider + model id."""
    return next((m for m in models if same_model_key(m, model_id, provider_id)), None)


def format_vision(model: dict) -> str:
    """Only explicit supportsVision: true enables image input in AgentVis."""
    return "yes" if model.get("supportsVision") is True else "no"


def validate_provider_id(provider_id: str) -> None:
    """Validate provider id and print the available values when invalid."""
    if provider_id not in VALID_PROVIDER_IDS:
        print(f"❌ Invalid provider ID: {provider_id}", file=sys.stderr)
        print(f"Available values: {', '.join(sorted(VALID_PROVIDER_IDS))}", file=sys.stderr)
        sys.exit(1)


def build_user_model(
    provider_id: str,
    model_id: str,
    model_name: str,
    context_window: int,
    supports_vision: bool,
) -> dict:
    """Normalize and validate a user-defined model entry."""
    validate_provider_id(provider_id)

    if not model_id or not model_id.strip():
        print("❌ Model ID cannot be empty", file=sys.stderr)
        sys.exit(1)

    if not model_name or not model_name.strip():
        print("❌ Model display name cannot be empty", file=sys.stderr)
        sys.exit(1)

    if context_window <= 0:
        print("❌ Context window size must be greater than 0", file=sys.stderr)
        sys.exit(1)

    model = {
        "id": model_id.strip(),
        "name": model_name.strip(),
        "providerId": provider_id,
        "contextWindow": int(context_window),
    }
    if supports_vision is True:
        model["supportsVision"] = True
    return model


# ============================================================================
# Action implementations
# ============================================================================

def action_list_providers() -> None:
    """List all built-in providers."""
    print("📋 AgentVis built-in provider list:\n")
    print(f"{'ID':<25} {'Name':<25} {'Protocol':<10}")
    print("-" * 60)
    for p in BUILTIN_PROVIDERS:
        print(f"{p['id']:<25} {p['name']:<25} {p['protocol']:<10}")
    print(f"\nTotal {len(BUILTIN_PROVIDERS)} providers")


def action_list_models(app_data_dir: str, provider_id: str) -> None:
    """List all models under the specified provider (built-in + user-defined)."""
    validate_provider_id(provider_id)

    # Get provider name
    provider_name = next(
        (p["name"] for p in BUILTIN_PROVIDERS if p["id"] == provider_id),
        provider_id,
    )

    # Built-in models
    builtin = [m for m in BUILTIN_MODELS if m["providerId"] == provider_id]
    # User-defined custom models
    config = load_config(app_data_dir)
    user_models = [m for m in config["models"] if m.get("providerId") == provider_id]

    # Merge and deduplicate (user configuration overrides built-in)
    user_keys = {f"{m['id']}::{m['providerId']}" for m in user_models}
    merged = [m for m in builtin if f"{m['id']}::{m['providerId']}" not in user_keys] + user_models

    print(f"📋 {provider_name} ({provider_id}) model list:\n")
    print(f"{'ID':<40} {'Name':<30} {'Context Window':<15} {'Vision':<7} {'Source':<8}")
    print("-" * 105)

    for m in merged:
        source = "Custom" if f"{m['id']}::{m['providerId']}" in user_keys else "Built-in"
        ctx = f"{m['contextWindow']:,}"
        print(f"{m['id']:<40} {m['name']:<30} {ctx:<15} {format_vision(m):<7} {source:<8}")

    print(f"\nTotal {len(merged)} models (built-in {len(merged) - len(user_models)}, custom {len(user_models)})")


def action_add_model(
    app_data_dir: str,
    provider_id: str,
    model_id: str,
    model_name: str,
    context_window: int,
    supports_vision: bool,
) -> None:
    """Add a user-defined custom model. Existing models must be edited explicitly."""
    config = load_config(app_data_dir)
    new_model = build_user_model(provider_id, model_id, model_name, context_window, supports_vision)

    builtin_match = find_model(BUILTIN_MODELS, new_model["id"], new_model["providerId"])
    custom_match = find_model(config["models"], new_model["id"], new_model["providerId"])
    if builtin_match or custom_match:
        source = "built-in" if builtin_match else "custom"
        print(
            f"❌ Model already exists as a {source} model: {new_model['id']} (provider: {new_model['providerId']})",
            file=sys.stderr,
        )
        print("   Use --action edit_model for an existing custom model, or choose a different model ID.", file=sys.stderr)
        sys.exit(1)

    config["models"].append(new_model)
    save_config(app_data_dir, config)
    print(f"✅ Added model: {new_model['name']} ({new_model['id']}) → {provider_id}")

    print(f"   Context window: {new_model['contextWindow']:,} tokens")
    print(f"   Vision input: {format_vision(new_model)}")
    print(f"   Configuration file: {get_config_path(app_data_dir)}")
    print("\n💡 Tip: Restart AgentVis to load external file changes. UI edits take effect immediately.")


def action_edit_model(
    app_data_dir: str,
    provider_id: str,
    model_id: str,
    model_name: Optional[str],
    context_window: Optional[int],
    supports_vision: Optional[bool],
    new_provider_id: Optional[str],
    new_model_id: Optional[str],
) -> None:
    """Edit an existing user-defined custom model."""
    validate_provider_id(provider_id)
    config = load_config(app_data_dir)

    existing_idx = next(
        (i for i, m in enumerate(config["models"]) if same_model_key(m, model_id, provider_id)),
        None,
    )
    if existing_idx is None:
        if find_model(BUILTIN_MODELS, model_id, provider_id):
            print(f"❌ {model_id} is a built-in model and cannot be edited with this script.", file=sys.stderr)
            print("   Add a new custom model with a different ID, or use JSON import for intentional batch overrides.", file=sys.stderr)
        else:
            print(f"❌ Custom model not found: {model_id} (provider: {provider_id})", file=sys.stderr)
        sys.exit(1)

    existing = config["models"][existing_idx]
    target_provider_id = new_provider_id.strip() if new_provider_id else provider_id
    target_model_id = new_model_id.strip() if new_model_id else model_id
    target_name = model_name.strip() if model_name else str(existing.get("name", target_model_id))
    target_context_window = int(context_window) if context_window is not None else int(existing.get("contextWindow", 0))
    target_supports_vision = supports_vision if supports_vision is not None else existing.get("supportsVision") is True

    updated_model = build_user_model(
        target_provider_id,
        target_model_id,
        target_name,
        target_context_window,
        target_supports_vision,
    )

    duplicate_builtin = find_model(BUILTIN_MODELS, updated_model["id"], updated_model["providerId"])
    duplicate_custom = next(
        (
            m for i, m in enumerate(config["models"])
            if i != existing_idx and same_model_key(m, updated_model["id"], updated_model["providerId"])
        ),
        None,
    )
    if duplicate_builtin or duplicate_custom:
        source = "built-in" if duplicate_builtin else "custom"
        print(
            f"❌ Target model already exists as a {source} model: {updated_model['id']} "
            f"(provider: {updated_model['providerId']})",
            file=sys.stderr,
        )
        sys.exit(1)

    config["models"][existing_idx] = updated_model
    save_config(app_data_dir, config)
    print(f"✅ Updated model: {updated_model['name']} ({updated_model['id']}) → {updated_model['providerId']}")
    print(f"   Context window: {updated_model['contextWindow']:,} tokens")
    print(f"   Vision input: {format_vision(updated_model)}")
    print(f"   Configuration file: {get_config_path(app_data_dir)}")
    print("\n💡 Tip: Restart AgentVis to load external file changes. UI edits take effect immediately.")


def action_remove_model(app_data_dir: str, provider_id: str, model_id: str) -> None:
    """Remove the specified model from user-defined custom models."""
    validate_provider_id(provider_id)

    if not model_id or not model_id.strip():
        print("❌ Model ID cannot be empty", file=sys.stderr)
        sys.exit(1)

    config = load_config(app_data_dir)

    # Find the model to remove
    original_count = len(config["models"])
    config["models"] = [
        m for m in config["models"]
        if not (m.get("id") == model_id and m.get("providerId") == provider_id)
    ]

    if len(config["models"]) == original_count:
        # Check whether it is a built-in model
        is_builtin = any(
            m["id"] == model_id and m["providerId"] == provider_id
            for m in BUILTIN_MODELS
        )
        if is_builtin:
            print(f"❌ {model_id} is a built-in model and cannot be removed.")
            print("   Built-in models are maintained by the application; users can only remove custom models.")
        else:
            print(f"❌ Custom model not found: {model_id} (provider: {provider_id})")
        sys.exit(1)

    save_config(app_data_dir, config)
    print(f"✅ Removed custom model: {model_id} (provider: {provider_id})")
    print(f"   Current custom model count: {len(config['models'])}")


# ============================================================================
# CLI entry point
# ============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(
        description="AgentVis model configuration management tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--action", required=True,
                        choices=["list_providers", "list_models", "add_model", "edit_model", "remove_model"],
                        help="Operation type")
    parser.add_argument("--app-data-dir", "--app_data_dir", required=True,
                        help="App data directory path")
    parser.add_argument("--provider-id", "--provider_id", default=None,
                        help="Provider ID")
    parser.add_argument("--model-id", "--model_id", default=None,
                        help="Model ID")
    parser.add_argument("--model-name", "--model_name", default=None,
                        help="Model display name")
    parser.add_argument("--context-window", "--context_window", type=int, default=None,
                        help="Context window size (tokens)")
    parser.add_argument("--supports-vision", "--supports_vision", nargs="?", const=True, default=None, type=parse_bool,
                        help="Whether the model supports image input (true/false). Only true enables image input.")
    parser.add_argument("--new-provider-id", "--new_provider_id", default=None,
                        help="New provider ID for edit_model")
    parser.add_argument("--new-model-id", "--new_model_id", default=None,
                        help="New model ID for edit_model")

    args = parser.parse_args()

    if args.action == "list_providers":
        action_list_providers()

    elif args.action == "list_models":
        if not args.provider_id:
            print("❌ list_models operation requires the --provider-id parameter", file=sys.stderr)
            sys.exit(1)
        action_list_models(args.app_data_dir, args.provider_id)

    elif args.action == "add_model":
        missing = []
        if not args.provider_id:
            missing.append("--provider-id")
        if not args.model_id:
            missing.append("--model-id")
        if not args.model_name:
            missing.append("--model-name")
        if args.context_window is None:
            missing.append("--context-window")
        if missing:
            print(f"❌ add_model operation is missing required parameters: {', '.join(missing)}", file=sys.stderr)
            sys.exit(1)
        action_add_model(
            args.app_data_dir,
            args.provider_id,
            args.model_id,
            args.model_name,
            args.context_window,
            args.supports_vision is True,
        )

    elif args.action == "edit_model":
        missing = []
        if not args.provider_id:
            missing.append("--provider-id")
        if not args.model_id:
            missing.append("--model-id")
        if missing:
            print(f"❌ edit_model operation is missing required parameters: {', '.join(missing)}", file=sys.stderr)
            sys.exit(1)
        action_edit_model(
            args.app_data_dir,
            args.provider_id,
            args.model_id,
            args.model_name,
            args.context_window,
            args.supports_vision,
            args.new_provider_id,
            args.new_model_id,
        )

    elif args.action == "remove_model":
        if not args.provider_id:
            print("❌ remove_model operation requires the --provider-id parameter", file=sys.stderr)
            sys.exit(1)
        if not args.model_id:
            print("❌ remove_model operation requires the --model-id parameter", file=sys.stderr)
            sys.exit(1)
        action_remove_model(args.app_data_dir, args.provider_id, args.model_id)


if __name__ == "__main__":
    main()
