---
name: model-config
description: Manage custom model configurations for AgentVis. Guide users to the Settings UI for normal add/edit flows, and use the bundled script for batch or offline custom model configuration.
triggers: [模型配置, 添加模型, 新增模型, 删除模型,模型管理, 配置模型, model config, add model, delete model, model management, configure model]
---

# Model Config skill for AgentVis — Model Configuration Management Skill

Manage custom model configuration for the AgentVis application.

For normal interactive use, prefer the AgentVis Settings UI:

1. Open Settings → Models.
2. Choose an existing provider.
3. Enter the model ID, optional display name, context window size, and the multimodal/vision checkbox.
4. Save. The UI blocks duplicate `(providerId, modelId)` entries and provides a separate edit action for existing custom models.

Use the script below only when the user explicitly wants automation, batch changes, offline edits, or direct access to `model-config.json`.

## Quick Usage — Recommended Method

Use the `scripts/model_config.py` script to complete all model configuration operations. The script only depends on the Python standard library and does not require installing any additional dependencies.

```bash
# List all providers
python scripts/model_config.py --action list_providers --app-data-dir "APP_DATA_DIR"

# List models under a specified provider
python scripts/model_config.py --action list_models --app-data-dir "APP_DATA_DIR" --provider-id PROVIDER_ID

# Add model; fails if provider + model ID already exists
python scripts/model_config.py --action add_model --app-data-dir "APP_DATA_DIR" --provider-id PROVIDER_ID --model-id MODEL_ID --model-name "DISPLAY_NAME" --context-window CONTEXT_WINDOW --supports-vision false

# Edit an existing custom model
python scripts/model_config.py --action edit_model --app-data-dir "APP_DATA_DIR" --provider-id PROVIDER_ID --model-id MODEL_ID --model-name "DISPLAY_NAME" --context-window CONTEXT_WINDOW --supports-vision true

# Remove custom model
python scripts/model_config.py --action remove_model --app-data-dir "APP_DATA_DIR" --provider-id PROVIDER_ID --model-id MODEL_ID
```

> **Note:** `APP_DATA_DIR` on Windows is usually `C:/Users/{user}/AppData/Roaming/com.agentvis.app`.

## Script Parameters

| Parameter | Description | Required |
|------|------|------|
| `--action` | Operation type: `list_providers` / `list_models` / `add_model` / `edit_model` / `remove_model` | Yes |
| `--app-data-dir` | App data directory path (the directory containing `model-config.json`) | Yes |
| `--provider-id` | Provider ID (required for `list_models`/`add_model`/`edit_model`/`remove_model`) | Depends on operation |
| `--model-id` | Model ID, the identifier passed to the API (required for `add_model`/`edit_model`/`remove_model`) | Depends on operation |
| `--model-name` | Model display name (required for `add_model`; optional for `edit_model`) | Depends on operation |
| `--context-window` | Context window size in tokens (required for `add_model`; optional for `edit_model`) | Depends on operation |
| `--supports-vision` | Whether the model supports image input. Accepts `true`/`false`; only `true` enables image input. | No |
| `--new-provider-id` | New provider ID when editing and changing the model key | No |
| `--new-model-id` | New model ID when editing and changing the model key | No |

## Available Provider IDs

| ID | Name | Protocol |
|----|------|------|
| `openai` | OpenAI | openai |
| `anthropic` | Anthropic | anthropic |
| `gemini` | Google AI | gemini |
| `zhipu` | ZhipuAI | openai |
| `deepseek` | DeepSeek | openai |
| `agnes` | Agnes AI | openai |
| `stepfun` | StepFun (Step Plan) | openai |
| `xiaomi-mimo` | Xiaomi(Token Plan) | openai |
| `zhipu-coding` | ZhipuAI (Coding Plan) | openai |
| `minimax` | MiniMax(Token Plan) | anthropic |
| `volcengine` | Volcengine (Coding Plan) | openai |
| `openrouter` | OpenRouter | openai |
| `local` | Local (local proxy) | gemini |

## Workflow

When the user asks to add a model:

1. Prefer the Settings → Models UI when the user can operate the app directly.
2. Confirm the provider, model ID, display name, context window size, and whether the model supports vision/image input.
3. Explain that unchecked/false `supportsVision` disables image input for that model, even if the provider can technically route images.
4. If using the script, use `list_models` first to avoid duplicates. `add_model` refuses an existing built-in or custom `(providerId, modelId)`.
5. Use `edit_model` for an existing custom model. Built-in models cannot be edited with this script.
6. Tell the user that UI changes take effect immediately; external script/file changes require restarting AgentVis so the runtime reloads `model-config.json`.

## Common Scenarios

### Add a New Model
```bash
python scripts/model_config.py --action add_model --app-data-dir "C:/Users/Admin/AppData/Roaming/com.agentvis.app" --provider-id volcengine --model-id "deepseek-r2" --model-name "DeepSeek R2" --context-window 128000 --supports-vision false
```

### Edit a Custom Model
```bash
python scripts/model_config.py --action edit_model --app-data-dir "C:/Users/Admin/AppData/Roaming/com.agentvis.app" --provider-id volcengine --model-id "deepseek-r2" --model-name "DeepSeek R2 Vision" --context-window 128000 --supports-vision true
```

### View the Model List for a Provider
```bash
python scripts/model_config.py --action list_models --app-data-dir "C:/Users/Admin/AppData/Roaming/com.agentvis.app" --provider-id openai
```

### Remove a Custom Model
```bash
python scripts/model_config.py --action remove_model --app-data-dir "C:/Users/Admin/AppData/Roaming/com.agentvis.app" --provider-id openai --model-id "gpt-test"
```

## Notes

- Only user-defined custom models can be removed; built-in models cannot be removed
- `add_model` refuses duplicate `(providerId, modelId)` entries. Use `edit_model` to modify an existing custom model.
- JSON import/export is still available in the Settings UI for batch migration. JSON import intentionally overwrites the merged model entry with the same `(providerId, modelId)`, including built-in display configuration when deliberately provided.
- `supportsVision` is model-level, not provider-level. Only explicit `supportsVision: true` allows image input; false or missing means AgentVis strips/disables images before calling the LLM.
- After modifying `model-config.json` with this script or another external editor, restart AgentVis so the runtime reloads the file. Changes made through the Settings UI take effect immediately.
- `zhipu-coding` and `zhipu` use the **same API Key**, but go through an independent Coding Plan endpoint (`/api/coding/paas/v4`), which needs to be filled in separately once on the settings page
- `stepfun` uses the Step Plan endpoint (`https://api.stepfun.com/step_plan/v1`) and requires a Step Plan API Key configured separately on the settings page
