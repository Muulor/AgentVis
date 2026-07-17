//! Route-scoped reasoning controls for supported LLM APIs.
//!
//! The UI sends a provider-neutral preset. This module is the only place that
//! maps that preset to provider protocol semantics. Unknown and unverified
//! compatible routes deliberately preserve their legacy request bodies.

use serde::{Deserialize, Serialize};

/// Provider-neutral reasoning level selected by the user.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningPreset {
    /// Keep the route's existing AgentVis behavior.
    #[default]
    Recommended,
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl<'de> Deserialize<'de> for ReasoningPreset {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "recommended" => Self::Recommended,
            "none" => Self::None,
            "minimal" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::Xhigh,
            "max" => Self::Max,
            _ => Self::Recommended,
        })
    }
}

/// The verified API route/profile used for reasoning parameter translation.
///
/// `Auto` exists for internal callers that construct adapters directly. Tauri
/// commands set an explicit route so a Local or aggregator model never inherits
/// first-party behavior just because its model id looks familiar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningRoute {
    #[default]
    Auto,
    NativeOpenAiResponses,
    NativeAnthropicMessages,
    NativeGeminiGenerateContent,
    DeepSeekChat,
    MiniMaxMessages,
    StepFunChat,
    ZhipuChat,
    MimoChat,
    VolcengineChat,
    OpenRouterChat,
    Unknown,
}

impl ReasoningRoute {
    pub fn for_provider_id(provider_id: &str) -> Self {
        match provider_id {
            "openai" => Self::NativeOpenAiResponses,
            "anthropic" => Self::NativeAnthropicMessages,
            "gemini" => Self::NativeGeminiGenerateContent,
            "deepseek" => Self::DeepSeekChat,
            "minimax" => Self::MiniMaxMessages,
            "stepfun" => Self::StepFunChat,
            "zhipu" | "zhipu-coding" => Self::ZhipuChat,
            "xiaomi-mimo" => Self::MimoChat,
            "volcengine" => Self::VolcengineChat,
            "openrouter" => Self::OpenRouterChat,
            // Local and other compatible endpoints must not inherit a
            // first-party profile based only on their model id.
            _ => Self::Unknown,
        }
    }

    pub fn resolve_auto(self, native_fallback: Self) -> Self {
        if self == Self::Auto {
            native_fallback
        } else {
            self
        }
    }
}

/// Typed protocol-level result. Adapters translate these variants into their
/// own request structs; callers cannot inject arbitrary provider JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolvedReasoning {
    /// Do not add any new reasoning fields. Existing adapter behavior remains.
    Preserve,
    OpenAiResponses {
        effort: &'static str,
    },
    OpenAiCompatibleEffort {
        effort: &'static str,
    },
    AnthropicAdaptive {
        effort: &'static str,
    },
    GeminiThinking {
        /// `None` keeps the model's native thinking level while still asking
        /// for thought summaries, which is AgentVis's legacy behavior.
        level: Option<&'static str>,
    },
    CompatibleThinking {
        enabled: bool,
        effort: Option<&'static str>,
    },
    ThinkingToggle {
        enabled: bool,
    },
    OpenRouter {
        enabled: bool,
        effort: Option<&'static str>,
    },
}

pub(crate) fn resolve_reasoning(
    route: ReasoningRoute,
    model: &str,
    preset: Option<ReasoningPreset>,
) -> ResolvedReasoning {
    let preset = preset.unwrap_or_default();
    let resolved = match route {
        ReasoningRoute::NativeOpenAiResponses => resolve_openai(model, preset),
        ReasoningRoute::NativeAnthropicMessages => resolve_anthropic(model, preset),
        ReasoningRoute::NativeGeminiGenerateContent => resolve_gemini(model, preset),
        ReasoningRoute::DeepSeekChat => resolve_deepseek(model, preset),
        ReasoningRoute::MiniMaxMessages => resolve_minimax(model, preset),
        ReasoningRoute::StepFunChat => resolve_stepfun(model, preset),
        ReasoningRoute::ZhipuChat => resolve_zhipu(model, preset),
        ReasoningRoute::MimoChat => resolve_mimo(model, preset),
        ReasoningRoute::VolcengineChat => resolve_volcengine(model, preset),
        ReasoningRoute::OpenRouterChat => resolve_openrouter(model, preset),
        ReasoningRoute::Auto | ReasoningRoute::Unknown => ResolvedReasoning::Preserve,
    };
    log::trace!(
        "[LLM][reasoning] route={:?}, model={}, requested={:?}, resolved={:?}",
        route,
        model,
        preset,
        resolved
    );
    resolved
}

fn normalized_model(model: &str) -> String {
    model.trim().to_ascii_lowercase().replace('.', "-")
}

fn resolve_openai(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);
    if !model.starts_with("gpt-5") {
        return ResolvedReasoning::Preserve;
    }

    // Missing/recommended preserves the existing explicit medium default for
    // all native GPT-5 Responses requests, including future model ids.
    if preset == ReasoningPreset::Recommended {
        return ResolvedReasoning::OpenAiResponses { effort: "medium" };
    }

    let supports_verified_effort = model.starts_with("gpt-5-4")
        || model.starts_with("gpt-5-5")
        || model.starts_with("gpt-5-6");
    if !supports_verified_effort {
        // The Responses builder will preserve its legacy medium fallback, while
        // Chat Completions builders omit unsupported explicit controls.
        return ResolvedReasoning::Preserve;
    }

    let supports_max = model.starts_with("gpt-5-6");
    let effort = match preset {
        ReasoningPreset::Recommended => "medium",
        ReasoningPreset::None => "none",
        // Current native GPT-5 routes reject `minimal`. Stale persisted values
        // defensively clamp to the closest supported level.
        ReasoningPreset::Minimal => "low",
        ReasoningPreset::Low => "low",
        ReasoningPreset::Medium => "medium",
        ReasoningPreset::High => "high",
        ReasoningPreset::Xhigh => "xhigh",
        ReasoningPreset::Max if supports_max => "max",
        ReasoningPreset::Max => "xhigh",
    };
    ResolvedReasoning::OpenAiResponses { effort }
}

pub(crate) fn anthropic_model_uses_adaptive_thinking(model: &str) -> bool {
    let model = normalized_model(model);
    if !model.contains("claude") {
        return false;
    }

    const OPUS_VERSIONS: &[&str] = &["4-5", "4-6", "4-7", "4-8"];
    const SONNET_VERSIONS: &[&str] = &["4-5", "4-6", "5"];

    OPUS_VERSIONS
        .iter()
        .any(|version| model_matches_family_version(&model, "opus", version))
        || SONNET_VERSIONS
            .iter()
            .any(|version| model_matches_family_version(&model, "sonnet", version))
        || model_matches_family_version(&model, "fable", "5")
        || model.contains("mythos-5")
        || model.contains("mythos-preview")
}

fn model_matches_family_version(model: &str, family: &str, version: &str) -> bool {
    model.contains(&format!("{family}-{version}")) || model.contains(&format!("{version}-{family}"))
}

fn resolve_anthropic(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    if !anthropic_model_uses_adaptive_thinking(model) {
        return ResolvedReasoning::Preserve;
    }

    // The currently exposed native adaptive models use effort levels rather
    // than a portable off switch. Defensive none/minimal inputs clamp to low.
    let is_sonnet_46 = {
        let model = normalized_model(model);
        model_matches_family_version(&model, "sonnet", "4-6")
    };
    let effort = match preset {
        ReasoningPreset::Recommended => "high",
        ReasoningPreset::None | ReasoningPreset::Minimal | ReasoningPreset::Low => "low",
        ReasoningPreset::Medium => "medium",
        ReasoningPreset::High => "high",
        // Claude Sonnet 4.6 rejects xhigh. Normalize stale or defensive inputs
        // downward instead of unexpectedly increasing cost to max.
        ReasoningPreset::Xhigh if is_sonnet_46 => "high",
        ReasoningPreset::Xhigh => "xhigh",
        ReasoningPreset::Max => "max",
    };
    ResolvedReasoning::AnthropicAdaptive { effort }
}

fn resolve_gemini(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);

    let is_flash = (model.starts_with("gemini-3-flash") || model.starts_with("gemini-3-5-flash"))
        && model.contains("flash")
        && !model.contains("image");
    let is_31_pro = model.starts_with("gemini-3-1-pro");

    if !is_flash && !is_31_pro {
        // Preserve the native thought-summary behavior for other Gemini 2.5/3
        // models without guessing a new effort mapping.
        return if model.contains("gemini-2-5") || model.contains("gemini-3") {
            ResolvedReasoning::GeminiThinking { level: None }
        } else {
            ResolvedReasoning::Preserve
        };
    }

    if preset == ReasoningPreset::Recommended {
        return ResolvedReasoning::GeminiThinking { level: None };
    }

    let level = if is_31_pro {
        match preset {
            ReasoningPreset::Recommended => None,
            ReasoningPreset::None | ReasoningPreset::Minimal | ReasoningPreset::Low => Some("low"),
            ReasoningPreset::Medium => Some("medium"),
            ReasoningPreset::High | ReasoningPreset::Xhigh | ReasoningPreset::Max => Some("high"),
        }
    } else {
        match preset {
            ReasoningPreset::Recommended => None,
            ReasoningPreset::None | ReasoningPreset::Minimal => Some("minimal"),
            ReasoningPreset::Low => Some("low"),
            ReasoningPreset::Medium => Some("medium"),
            ReasoningPreset::High | ReasoningPreset::Xhigh | ReasoningPreset::Max => Some("high"),
        }
    };

    ResolvedReasoning::GeminiThinking { level }
}

fn resolve_deepseek(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);
    if !matches!(model.as_str(), "deepseek-v4-pro" | "deepseek-v4-flash")
        || preset == ReasoningPreset::Recommended
    {
        return ResolvedReasoning::Preserve;
    }

    match preset {
        ReasoningPreset::Recommended => ResolvedReasoning::Preserve,
        ReasoningPreset::None => ResolvedReasoning::CompatibleThinking {
            enabled: false,
            // DeepSeek uses the thinking toggle to disable reasoning and does
            // not accept `none` as a reasoning_effort value.
            effort: None,
        },
        ReasoningPreset::Minimal
        | ReasoningPreset::Low
        | ReasoningPreset::Medium
        | ReasoningPreset::High => ResolvedReasoning::CompatibleThinking {
            enabled: true,
            effort: Some("high"),
        },
        ReasoningPreset::Xhigh | ReasoningPreset::Max => ResolvedReasoning::CompatibleThinking {
            enabled: true,
            effort: Some("max"),
        },
    }
}

fn resolve_minimax(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);
    if model != "minimax-m3" || preset == ReasoningPreset::Recommended {
        return ResolvedReasoning::Preserve;
    }

    // MiniMax-M3 exposes an Anthropic-compatible adaptive/disabled toggle,
    // without Claude's output_config.effort levels. M2.x intentionally stays
    // unregistered because its thinking mode cannot be disabled.
    ResolvedReasoning::ThinkingToggle {
        enabled: preset != ReasoningPreset::None,
    }
}

fn resolve_stepfun(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);
    if model != "step-3-7-flash" || preset == ReasoningPreset::Recommended {
        return ResolvedReasoning::Preserve;
    }

    let effort = match preset {
        ReasoningPreset::Recommended => return ResolvedReasoning::Preserve,
        ReasoningPreset::None | ReasoningPreset::Minimal | ReasoningPreset::Low => "low",
        ReasoningPreset::Medium => "medium",
        ReasoningPreset::High | ReasoningPreset::Xhigh | ReasoningPreset::Max => "high",
    };
    ResolvedReasoning::OpenAiCompatibleEffort { effort }
}

fn resolve_zhipu(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);

    if model.starts_with("glm-5-1") {
        return if preset == ReasoningPreset::None {
            ResolvedReasoning::ThinkingToggle { enabled: false }
        } else {
            // GLM-5.1 has no verified effort parameter. Recommended and any
            // defensive non-none input keep the old body unchanged.
            ResolvedReasoning::Preserve
        };
    }

    if !model.starts_with("glm-5-2") || preset == ReasoningPreset::Recommended {
        return ResolvedReasoning::Preserve;
    }

    match preset {
        ReasoningPreset::Recommended => ResolvedReasoning::Preserve,
        ReasoningPreset::None | ReasoningPreset::Minimal => ResolvedReasoning::CompatibleThinking {
            enabled: false,
            effort: Some("none"),
        },
        ReasoningPreset::Low | ReasoningPreset::Medium | ReasoningPreset::High => {
            ResolvedReasoning::CompatibleThinking {
                enabled: true,
                effort: Some("high"),
            }
        }
        ReasoningPreset::Xhigh | ReasoningPreset::Max => ResolvedReasoning::CompatibleThinking {
            enabled: true,
            effort: Some("max"),
        },
    }
}

fn resolve_mimo(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);
    if !matches!(model.as_str(), "mimo-v2-5" | "mimo-v2-5-pro")
        || preset == ReasoningPreset::Recommended
    {
        return ResolvedReasoning::Preserve;
    }

    ResolvedReasoning::ThinkingToggle {
        enabled: preset != ReasoningPreset::None,
    }
}

fn resolve_volcengine(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);

    match model.as_str() {
        "deepseek-v4-pro" | "deepseek-v4-flash" => resolve_deepseek(&model, preset),
        "glm-5-2" => resolve_zhipu(&model, preset),
        "kimi-k2-6" => match preset {
            ReasoningPreset::None => ResolvedReasoning::ThinkingToggle { enabled: false },
            // Only the verified off switch is exposed for K2.6 on this route.
            _ => ResolvedReasoning::Preserve,
        },
        // K2.7 Code always thinks. Neither its off switch nor an effort field
        // is verified on the Volcengine Coding Plan route, so preserve the body.
        "kimi-k2-7-code" => ResolvedReasoning::Preserve,
        "minimax-m3" => match preset {
            ReasoningPreset::None => ResolvedReasoning::ThinkingToggle { enabled: false },
            _ => ResolvedReasoning::Preserve,
        },
        _ => ResolvedReasoning::Preserve,
    }
}

fn resolve_openrouter(model: &str, preset: ReasoningPreset) -> ResolvedReasoning {
    let model = normalized_model(model);
    if model == "minimax/minimax-m3" {
        return ResolvedReasoning::OpenRouter {
            enabled: preset != ReasoningPreset::None,
            // OpenRouter reports that M3 is optional reasoning, but does not
            // advertise effort levels. Ignore stale non-none effort values.
            effort: None,
        };
    }

    if model == "stepfun/step-3-7-flash" {
        let effort = match preset {
            ReasoningPreset::Recommended => None,
            // OpenRouter marks reasoning as mandatory for this model. Clamp a
            // defensive off/minimal request to the lowest supported effort.
            ReasoningPreset::None | ReasoningPreset::Minimal | ReasoningPreset::Low => Some("low"),
            ReasoningPreset::Medium => Some("medium"),
            ReasoningPreset::High | ReasoningPreset::Xhigh | ReasoningPreset::Max => Some("high"),
        };
        return ResolvedReasoning::OpenRouter {
            enabled: true,
            effort,
        };
    }

    let effort = match preset {
        ReasoningPreset::Recommended | ReasoningPreset::None => None,
        ReasoningPreset::Minimal => Some("minimal"),
        ReasoningPreset::Low => Some("low"),
        ReasoningPreset::Medium => Some("medium"),
        ReasoningPreset::High => Some("high"),
        ReasoningPreset::Xhigh => Some("xhigh"),
        ReasoningPreset::Max => Some("max"),
    };

    ResolvedReasoning::OpenRouter {
        enabled: preset != ReasoningPreset::None,
        effort,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_verified_models_normalize_to_supported_effort() {
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::NativeOpenAiResponses,
                "gpt-5.4-mini",
                Some(ReasoningPreset::Xhigh),
            ),
            ResolvedReasoning::OpenAiResponses { effort: "xhigh" }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::NativeOpenAiResponses,
                "gpt-5.4",
                Some(ReasoningPreset::Minimal),
            ),
            ResolvedReasoning::OpenAiResponses { effort: "low" }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::NativeOpenAiResponses,
                "gpt-5.5",
                Some(ReasoningPreset::Max),
            ),
            ResolvedReasoning::OpenAiResponses { effort: "xhigh" }
        );
        for model in ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] {
            assert_eq!(
                resolve_reasoning(
                    ReasoningRoute::NativeOpenAiResponses,
                    model,
                    Some(ReasoningPreset::Max),
                ),
                ResolvedReasoning::OpenAiResponses { effort: "max" },
                "model={model}"
            );
        }
    }

    #[test]
    fn built_in_first_party_model_matrix_resolves_only_verified_controls() {
        for model in ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"] {
            assert_eq!(
                resolve_reasoning(
                    ReasoningRoute::NativeOpenAiResponses,
                    model,
                    Some(ReasoningPreset::High),
                ),
                ResolvedReasoning::OpenAiResponses { effort: "high" },
                "model={model}"
            );
        }
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::NativeOpenAiResponses,
                "gpt-5.5",
                Some(ReasoningPreset::Xhigh),
            ),
            ResolvedReasoning::OpenAiResponses { effort: "xhigh" }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::NativeOpenAiResponses,
                "gpt-5.6",
                Some(ReasoningPreset::Max),
            ),
            ResolvedReasoning::OpenAiResponses { effort: "max" }
        );

        for model in [
            "claude-sonnet-4-6",
            "claude-sonnet-5",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-fable-5",
        ] {
            assert_eq!(
                resolve_reasoning(
                    ReasoningRoute::NativeAnthropicMessages,
                    model,
                    Some(ReasoningPreset::Max),
                ),
                ResolvedReasoning::AnthropicAdaptive { effort: "max" },
                "model={model}"
            );
        }
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::NativeAnthropicMessages,
                "claude-sonnet-4-6",
                Some(ReasoningPreset::Xhigh),
            ),
            ResolvedReasoning::AnthropicAdaptive { effort: "high" }
        );

        for (model, preset, expected) in [
            (
                "gemini-3-flash-preview",
                ReasoningPreset::Minimal,
                "minimal",
            ),
            ("gemini-3.1-pro-preview", ReasoningPreset::Medium, "medium"),
            ("gemini-3.5-flash", ReasoningPreset::High, "high"),
        ] {
            assert_eq!(
                resolve_reasoning(
                    ReasoningRoute::NativeGeminiGenerateContent,
                    model,
                    Some(preset),
                ),
                ResolvedReasoning::GeminiThinking {
                    level: Some(expected)
                },
                "model={model}"
            );
        }

        for model in ["deepseek-v4-pro", "deepseek-v4-flash"] {
            assert_eq!(
                resolve_reasoning(
                    ReasoningRoute::DeepSeekChat,
                    model,
                    Some(ReasoningPreset::Max),
                ),
                ResolvedReasoning::CompatibleThinking {
                    enabled: true,
                    effort: Some("max")
                },
                "model={model}"
            );
        }

        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::MiniMaxMessages,
                "MiniMax-M3",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::ThinkingToggle { enabled: false }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::MiniMaxMessages,
                "MiniMax-M3",
                Some(ReasoningPreset::High),
            ),
            ResolvedReasoning::ThinkingToggle { enabled: true }
        );

        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::StepFunChat,
                "step-3.7-flash",
                Some(ReasoningPreset::Medium),
            ),
            ResolvedReasoning::OpenAiCompatibleEffort { effort: "medium" }
        );

        for model in ["mimo-v2.5", "mimo-v2.5-pro"] {
            assert_eq!(
                resolve_reasoning(ReasoningRoute::MimoChat, model, Some(ReasoningPreset::High),),
                ResolvedReasoning::ThinkingToggle { enabled: true },
                "model={model}"
            );
        }
    }

    #[test]
    fn provider_ids_resolve_only_to_verified_routes() {
        for provider in ["local", "agnes"] {
            assert_eq!(
                ReasoningRoute::for_provider_id(provider),
                ReasoningRoute::Unknown,
                "provider={provider}"
            );
        }
        assert_eq!(
            ReasoningRoute::for_provider_id("stepfun"),
            ReasoningRoute::StepFunChat
        );
        assert_eq!(
            ReasoningRoute::for_provider_id("minimax"),
            ReasoningRoute::MiniMaxMessages
        );
        assert_eq!(
            ReasoningRoute::for_provider_id("zhipu-coding"),
            ReasoningRoute::ZhipuChat
        );
        assert_eq!(
            ReasoningRoute::for_provider_id("openrouter"),
            ReasoningRoute::OpenRouterChat
        );
        assert_eq!(
            ReasoningRoute::for_provider_id("volcengine"),
            ReasoningRoute::VolcengineChat
        );
    }

    #[test]
    fn volcengine_maps_only_model_specific_verified_controls() {
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::VolcengineChat,
                "deepseek-v4-flash",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::CompatibleThinking {
                enabled: false,
                effort: None,
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::VolcengineChat,
                "glm-5.2",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::CompatibleThinking {
                enabled: false,
                effort: Some("none"),
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::VolcengineChat,
                "kimi-k2.6",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::ThinkingToggle { enabled: false }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::VolcengineChat,
                "Kimi-K2.7-Code",
                Some(ReasoningPreset::High),
            ),
            ResolvedReasoning::Preserve
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::VolcengineChat,
                "Kimi-K2.7-Code",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::Preserve
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::VolcengineChat,
                "MiniMax-M3",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::ThinkingToggle { enabled: false }
        );
    }

    #[test]
    fn openrouter_maps_gateway_presets_and_honors_model_metadata() {
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::OpenRouterChat,
                "xiaomi/mimo-v2.5",
                Some(ReasoningPreset::Recommended),
            ),
            ResolvedReasoning::OpenRouter {
                enabled: true,
                effort: None,
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::OpenRouterChat,
                "xiaomi/mimo-v2.5",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::OpenRouter {
                enabled: false,
                effort: None,
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::OpenRouterChat,
                "vendor/future-model",
                Some(ReasoningPreset::Xhigh),
            ),
            ResolvedReasoning::OpenRouter {
                enabled: true,
                effort: Some("xhigh"),
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::OpenRouterChat,
                "minimax/minimax-m3",
                Some(ReasoningPreset::High),
            ),
            ResolvedReasoning::OpenRouter {
                enabled: true,
                effort: None,
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::OpenRouterChat,
                "stepfun/step-3.7-flash",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::OpenRouter {
                enabled: true,
                effort: Some("low"),
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::OpenRouterChat,
                "stepfun/step-3.7-flash",
                Some(ReasoningPreset::Max),
            ),
            ResolvedReasoning::OpenRouter {
                enabled: true,
                effort: Some("high"),
            }
        );
    }

    #[test]
    fn deepseek_and_zhipu_aliases_resolve_to_effective_levels() {
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::DeepSeekChat,
                "deepseek-v4-flash",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::CompatibleThinking {
                enabled: false,
                effort: None
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::DeepSeekChat,
                "deepseek-v4-pro",
                Some(ReasoningPreset::Medium),
            ),
            ResolvedReasoning::CompatibleThinking {
                enabled: true,
                effort: Some("high")
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::for_provider_id("zhipu-coding"),
                "GLM-5.2",
                Some(ReasoningPreset::Xhigh),
            ),
            ResolvedReasoning::CompatibleThinking {
                enabled: true,
                effort: Some("max")
            }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::for_provider_id("zhipu-coding"),
                "GLM-5.1",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::ThinkingToggle { enabled: false }
        );
    }

    #[test]
    fn minimax_m3_toggle_does_not_leak_to_m2_models() {
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::MiniMaxMessages,
                "MiniMax-M3",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::ThinkingToggle { enabled: false }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::MiniMaxMessages,
                "MiniMax-M3",
                Some(ReasoningPreset::High),
            ),
            ResolvedReasoning::ThinkingToggle { enabled: true }
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::MiniMaxMessages,
                "MiniMax-M2.7",
                Some(ReasoningPreset::None),
            ),
            ResolvedReasoning::Preserve
        );
    }

    #[test]
    fn stepfun_37_clamps_semantic_presets_to_three_wire_levels() {
        for (preset, effort) in [
            (ReasoningPreset::None, "low"),
            (ReasoningPreset::Minimal, "low"),
            (ReasoningPreset::Low, "low"),
            (ReasoningPreset::Medium, "medium"),
            (ReasoningPreset::High, "high"),
            (ReasoningPreset::Xhigh, "high"),
            (ReasoningPreset::Max, "high"),
        ] {
            assert_eq!(
                resolve_reasoning(ReasoningRoute::StepFunChat, "step-3.7-flash", Some(preset)),
                ResolvedReasoning::OpenAiCompatibleEffort { effort },
                "preset={preset:?}"
            );
        }
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::StepFunChat,
                "step-3.7-flash",
                Some(ReasoningPreset::Recommended),
            ),
            ResolvedReasoning::Preserve
        );
    }

    #[test]
    fn unknown_routes_never_inherit_first_party_model_behavior() {
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::Unknown,
                "gpt-5.5",
                Some(ReasoningPreset::Xhigh),
            ),
            ResolvedReasoning::Preserve
        );
        assert_eq!(
            resolve_reasoning(
                ReasoningRoute::Unknown,
                "glm-5.2",
                Some(ReasoningPreset::Max),
            ),
            ResolvedReasoning::Preserve
        );
    }

    #[test]
    fn preset_deserialization_normalizes_unknown_strings_to_recommended() {
        assert_eq!(
            serde_json::from_str::<ReasoningPreset>(r#""xhigh""#).unwrap(),
            ReasoningPreset::Xhigh
        );
        assert_eq!(
            serde_json::from_str::<ReasoningPreset>(r#""future-level""#).unwrap(),
            ReasoningPreset::Recommended
        );
        assert_eq!(
            serde_json::from_str::<ReasoningPreset>(r#""HIGH""#).unwrap(),
            ReasoningPreset::Recommended
        );
    }
}
