//! Cloud embedding and rerank commands.
//!
//! Built-in requests use SiliconFlow (and the legacy Zhipu embedding adapter).
//! Custom RAG requests deliberately expose only small, explicit protocol
//! profiles and fixed credential slots. They are not a generic authenticated
//! HTTP proxy.

use chrono::{DateTime, Utc};
use futures::StreamExt;
use reqwest::{
    header::{HeaderMap, RETRY_AFTER},
    RequestBuilder, Response, StatusCode, Url,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::crypto::{Keystore, WindowsKeystore};
use crate::error::{AppError, CommandResult};
use crate::llm::http_client::get_rag_client;
use crate::AppState;

const SILICONFLOW_PROVIDER: &str = "siliconflow";
const ZHIPU_PROVIDER: &str = "zhipu";
const CUSTOM_PROVIDER: &str = "custom";
const CUSTOM_EMBEDDING_KEY_SLOT: &str = "rag-custom-embedding";
const GEMINI_EMBEDDING_KEY_SLOT: &str = "rag-gemini-embedding";
const CUSTOM_RERANKER_KEY_SLOT: &str = "rag-custom-reranker";
const BOUND_CUSTOM_RAG_CREDENTIAL_VERSION: u8 = 1;
const GEMINI_API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_API_HOST: &str = "generativelanguage.googleapis.com";
const GEMINI_EMBEDDING_001: &str = "gemini-embedding-001";
const GEMINI_EMBEDDING_2: &str = "gemini-embedding-2";
const MAX_ENDPOINT_LENGTH: usize = 2 * 1024;
const MAX_PROFILE_ID_LENGTH: usize = 512;
const MAX_BATCH_ITEMS: usize = 512;
const MAX_GEMINI_BATCH_ITEMS: usize = 25;
const MAX_TEXT_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_GEMINI_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_EMBEDDING_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_GEMINI_EMBEDDING_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RERANK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETRY_AFTER_MS: u64 = 120_000;

/// Cloud embedding request. Custom-only fields use camelCase on the IPC wire.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudEmbeddingRequest {
    pub provider: String,
    pub model: Option<String>,
    pub texts: Vec<String>,
    pub endpoint_url: Option<String>,
    pub protocol: Option<String>,
    pub auth_mode: Option<String>,
    pub purpose: Option<String>,
    pub profile_id: Option<String>,
    pub output_dimensionality: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct CloudEmbeddingResponse {
    pub embeddings: Vec<Vec<f32>>,
    pub dimension: usize,
    pub model: String,
}

/// Cloud rerank request. Custom-only fields use camelCase on the IPC wire.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRerankRequest {
    pub provider: String,
    pub model: Option<String>,
    pub query: String,
    pub documents: Vec<String>,
    pub top_n: Option<usize>,
    pub endpoint_url: Option<String>,
    pub protocol: Option<String>,
    pub auth_mode: Option<String>,
    pub purpose: Option<String>,
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CloudRerankResult {
    pub index: usize,
    pub relevance_score: f32,
}

#[derive(Debug, Serialize)]
pub struct CloudRerankResponse {
    pub results: Vec<CloudRerankResult>,
    pub model: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingResponse {
    data: Vec<OpenAiEmbeddingData>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct OpenAiEmbeddingData {
    embedding: Vec<f32>,
    #[serde(default)]
    index: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiBatchEmbedRequest {
    requests: Vec<GeminiEmbedRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeminiEmbedRequest {
    model: String,
    content: GeminiContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_type: Option<&'static str>,
    output_dimensionality: usize,
}

#[derive(Debug, Serialize)]
struct GeminiContent {
    parts: Vec<GeminiTextPart>,
}

#[derive(Debug, Serialize)]
struct GeminiTextPart {
    text: String,
}

#[derive(Debug, Deserialize)]
struct GeminiBatchEmbedResponse {
    embeddings: Vec<GeminiEmbedding>,
}

#[derive(Debug, Deserialize)]
struct GeminiEmbedding {
    values: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeminiModel {
    Embedding001,
    Embedding2,
}

impl GeminiModel {
    fn parse(model: &str) -> CommandResult<Self> {
        match model {
            GEMINI_EMBEDDING_001 => Ok(Self::Embedding001),
            GEMINI_EMBEDDING_2 => Ok(Self::Embedding2),
            _ => Err(AppError::LlmApi(
                "Gemini Embedding model must be gemini-embedding-001 or gemini-embedding-2"
                    .to_string(),
            )),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Embedding001 => GEMINI_EMBEDDING_001,
            Self::Embedding2 => GEMINI_EMBEDDING_2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeminiPurpose {
    Query,
    Document,
    Generic,
    Test,
}

impl GeminiPurpose {
    fn parse(purpose: &str) -> CommandResult<Self> {
        match purpose {
            "query" => Ok(Self::Query),
            "document" => Ok(Self::Document),
            "generic" => Ok(Self::Generic),
            "test" => Ok(Self::Test),
            _ => Err(AppError::LlmApi(format!(
                "Unsupported custom RAG purpose: {}",
                purpose
            ))),
        }
    }
}

#[derive(Debug, Deserialize)]
struct JinaCohereRerankResponse {
    results: Vec<CloudRerankResult>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VoyageRerankResponse {
    data: Vec<CloudRerankResult>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthMode {
    Bearer,
    None,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundCustomRagCredential {
    version: u8,
    endpoint_origin: String,
    api_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomRagCredentialState {
    Missing,
    Bound,
    DifferentEndpoint,
    Legacy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRagCredentialStatus {
    state: CustomRagCredentialState,
}

fn required_api_key(slot: &str, label: &str) -> CommandResult<String> {
    let keystore = WindowsKeystore::new();
    keystore
        .get_api_key(slot)?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::Keystore(format!("{} API key is not configured", label)))
}

fn required_trimmed<'a>(value: Option<&'a str>, field: &str) -> CommandResult<&'a str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::LlmApi(format!("Custom RAG {} is required", field)))
}

fn validate_model(value: Option<&str>) -> CommandResult<&str> {
    let model = required_trimmed(value, "model")?;
    if model.len() > 256 || model.chars().any(char::is_control) {
        return Err(AppError::LlmApi("Custom RAG model is invalid".to_string()));
    }
    Ok(model)
}

fn validate_profile_id(value: Option<&str>) -> CommandResult<&str> {
    let profile_id = required_trimmed(value, "profileId")?;
    if profile_id.len() > MAX_PROFILE_ID_LENGTH || profile_id.chars().any(char::is_control) {
        return Err(AppError::LlmApi(
            "Custom RAG profileId is invalid".to_string(),
        ));
    }
    Ok(profile_id)
}

fn validate_purpose<'a>(value: Option<&'a str>, allowed: &[&str]) -> CommandResult<&'a str> {
    let purpose = required_trimmed(value, "purpose")?;
    if !allowed.contains(&purpose) {
        return Err(AppError::LlmApi(format!(
            "Unsupported custom RAG purpose: {}",
            purpose
        )));
    }
    Ok(purpose)
}

fn parse_auth_mode(value: Option<&str>) -> CommandResult<AuthMode> {
    match required_trimmed(value, "authMode")? {
        "bearer" => Ok(AuthMode::Bearer),
        "none" => Ok(AuthMode::None),
        mode => Err(AppError::LlmApi(format!(
            "Unsupported custom RAG auth mode: {}",
            mode
        ))),
    }
}

fn validate_custom_endpoint(raw_endpoint: &str) -> CommandResult<Url> {
    let endpoint = raw_endpoint.trim();
    if endpoint.is_empty() || endpoint.len() > MAX_ENDPOINT_LENGTH {
        return Err(AppError::LlmApi(
            "Custom RAG endpoint is invalid".to_string(),
        ));
    }

    let url = Url::parse(endpoint)
        .map_err(|_| AppError::LlmApi("Custom RAG endpoint is not a valid URL".to_string()))?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::LlmApi(
            "Custom RAG endpoint must use HTTP or HTTPS".to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::LlmApi(
            "Custom RAG endpoint must not contain userinfo".to_string(),
        ));
    }
    if url.fragment().is_some() {
        return Err(AppError::LlmApi(
            "Custom RAG endpoint must not contain a fragment".to_string(),
        ));
    }
    if url.host_str().is_none() {
        return Err(AppError::LlmApi(
            "Custom RAG endpoint must include a host".to_string(),
        ));
    }
    if url.scheme() == "http" && !is_loopback_url(&url) {
        return Err(AppError::LlmApi(
            "Remote custom RAG endpoints must use HTTPS".to_string(),
        ));
    }

    Ok(url)
}

fn custom_credential_origin(endpoint: &Url) -> String {
    endpoint.origin().ascii_serialization()
}

fn serialize_bound_custom_credential(endpoint: &Url, api_key: &str) -> CommandResult<String> {
    Ok(serde_json::to_string(&BoundCustomRagCredential {
        version: BOUND_CUSTOM_RAG_CREDENTIAL_VERSION,
        endpoint_origin: custom_credential_origin(endpoint),
        api_key: api_key.to_string(),
    })?)
}

fn parse_bound_custom_credential(raw: &str) -> Option<BoundCustomRagCredential> {
    let credential: BoundCustomRagCredential = serde_json::from_str(raw).ok()?;
    if credential.version != BOUND_CUSTOM_RAG_CREDENTIAL_VERSION
        || credential.endpoint_origin.trim().is_empty()
        || credential.api_key.trim().is_empty()
    {
        return None;
    }
    Some(credential)
}

fn bound_custom_credential_state(
    stored: Option<&str>,
    endpoint_url: Option<&str>,
) -> CustomRagCredentialState {
    let Some(stored) = stored.filter(|value| !value.trim().is_empty()) else {
        return CustomRagCredentialState::Missing;
    };
    let Some(credential) = parse_bound_custom_credential(stored) else {
        return CustomRagCredentialState::Legacy;
    };
    let Ok(endpoint) = validate_custom_endpoint(endpoint_url.unwrap_or_default()) else {
        return CustomRagCredentialState::DifferentEndpoint;
    };
    if credential.endpoint_origin == custom_credential_origin(&endpoint) {
        CustomRagCredentialState::Bound
    } else {
        CustomRagCredentialState::DifferentEndpoint
    }
}

fn required_bound_custom_api_key(slot: &str, label: &str, endpoint: &Url) -> CommandResult<String> {
    let stored = required_api_key(slot, label)?;
    bound_custom_api_key_from_stored(&stored, label, endpoint)
}

fn bound_custom_api_key_from_stored(
    stored: &str,
    label: &str,
    endpoint: &Url,
) -> CommandResult<String> {
    let credential = parse_bound_custom_credential(stored).ok_or_else(|| {
        AppError::Keystore(format!(
            "{} API key must be saved again for the current endpoint",
            label
        ))
    })?;
    if credential.endpoint_origin != custom_credential_origin(endpoint) {
        return Err(AppError::Keystore(format!(
            "{} API key is configured for a different endpoint",
            label
        )));
    }
    Ok(credential.api_key)
}

fn validate_gemini_endpoint(raw_endpoint: Option<&str>) -> CommandResult<()> {
    let endpoint = required_trimmed(raw_endpoint, "endpointUrl")?;
    if endpoint.len() > MAX_ENDPOINT_LENGTH
        || !matches!(
            endpoint,
            GEMINI_API_BASE | "https://generativelanguage.googleapis.com/v1beta/"
        )
    {
        return Err(AppError::LlmApi(format!(
            "Gemini Embedding endpoint must be {}",
            GEMINI_API_BASE
        )));
    }

    let url = Url::parse(endpoint)
        .map_err(|_| AppError::LlmApi("Gemini Embedding endpoint is invalid".to_string()))?;
    let valid_path = matches!(url.path(), "/v1beta" | "/v1beta/");
    if url.scheme() != "https"
        || url.host_str() != Some(GEMINI_API_HOST)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !valid_path
    {
        return Err(AppError::LlmApi(format!(
            "Gemini Embedding endpoint must be {}",
            GEMINI_API_BASE
        )));
    }
    Ok(())
}

fn validate_gemini_auth_mode(value: Option<&str>) -> CommandResult<()> {
    match required_trimmed(value, "authMode")? {
        "google_api_key" => Ok(()),
        _ => Err(AppError::LlmApi(
            "Gemini Embedding authMode must be google_api_key".to_string(),
        )),
    }
}

fn validate_gemini_dimension(value: Option<usize>) -> CommandResult<usize> {
    match value {
        Some(dimension @ (768 | 1536 | 3072)) => Ok(dimension),
        _ => Err(AppError::LlmApi(
            "Gemini Embedding outputDimensionality must be 768, 1536, or 3072".to_string(),
        )),
    }
}

fn validate_gemini_batch_size(item_count: usize) -> CommandResult<()> {
    if item_count == 0 || item_count > MAX_GEMINI_BATCH_ITEMS {
        return Err(AppError::LlmApi(format!(
            "Gemini Embedding request must contain between 1 and {} inputs",
            MAX_GEMINI_BATCH_ITEMS
        )));
    }
    Ok(())
}

fn gemini_batch_endpoint(model: GeminiModel) -> CommandResult<Url> {
    fixed_endpoint(
        &format!(
            "{}/models/{}:batchEmbedContents",
            GEMINI_API_BASE,
            model.id()
        ),
        "Gemini Embedding",
    )
}

fn gemini_task_type(model: GeminiModel, purpose: GeminiPurpose) -> Option<&'static str> {
    if model == GeminiModel::Embedding2 {
        return None;
    }
    Some(match purpose {
        GeminiPurpose::Query | GeminiPurpose::Test => "RETRIEVAL_QUERY",
        GeminiPurpose::Document => "RETRIEVAL_DOCUMENT",
        GeminiPurpose::Generic => "SEMANTIC_SIMILARITY",
    })
}

fn gemini_text(model: GeminiModel, purpose: GeminiPurpose, text: &str) -> String {
    if model == GeminiModel::Embedding001 {
        return text.to_string();
    }
    match purpose {
        GeminiPurpose::Query | GeminiPurpose::Test => {
            format!("task: search result | query: {}", text)
        }
        GeminiPurpose::Document => format!("title: none | text: {}", text),
        GeminiPurpose::Generic => format!("task: sentence similarity | query: {}", text),
    }
}

fn build_gemini_batch_request(
    model: GeminiModel,
    purpose: GeminiPurpose,
    texts: &[String],
    output_dimensionality: usize,
) -> GeminiBatchEmbedRequest {
    let model_name = format!("models/{}", model.id());
    let task_type = gemini_task_type(model, purpose);
    GeminiBatchEmbedRequest {
        requests: texts
            .iter()
            .map(|text| GeminiEmbedRequest {
                model: model_name.clone(),
                content: GeminiContent {
                    parts: vec![GeminiTextPart {
                        text: gemini_text(model, purpose, text),
                    }],
                },
                task_type,
                output_dimensionality,
            })
            .collect(),
    }
}

fn serialize_gemini_batch_request(payload: &GeminiBatchEmbedRequest) -> CommandResult<Vec<u8>> {
    let body = serde_json::to_vec(payload).map_err(|_| {
        AppError::LlmApi("Gemini Embedding request serialization failed".to_string())
    })?;
    if body.len() > MAX_GEMINI_REQUEST_BODY_BYTES {
        return Err(AppError::LlmApi(format!(
            "Gemini Embedding request exceeds the {} byte serialized body limit",
            MAX_GEMINI_REQUEST_BODY_BYTES
        )));
    }
    Ok(body)
}

fn is_loopback_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

fn validate_embedding_inputs(texts: &[String]) -> CommandResult<()> {
    if texts.is_empty() {
        return Err(AppError::LlmApi(
            "Embedding request must contain at least one input".to_string(),
        ));
    }
    if texts.len() > MAX_BATCH_ITEMS {
        return Err(AppError::LlmApi(format!(
            "Embedding request exceeds the {} item limit",
            MAX_BATCH_ITEMS
        )));
    }
    if total_text_bytes(texts.iter().map(String::as_str)) > MAX_TEXT_PAYLOAD_BYTES {
        return Err(AppError::LlmApi(format!(
            "Embedding request exceeds the {} byte text limit",
            MAX_TEXT_PAYLOAD_BYTES
        )));
    }
    Ok(())
}

fn validate_rerank_inputs(
    query: &str,
    documents: &[String],
    top_n: Option<usize>,
) -> CommandResult<usize> {
    if query.trim().is_empty() {
        return Err(AppError::LlmApi(
            "Rerank query must not be empty".to_string(),
        ));
    }
    if documents.is_empty() {
        return Err(AppError::LlmApi(
            "Rerank request must contain at least one document".to_string(),
        ));
    }
    if documents.len() > MAX_BATCH_ITEMS {
        return Err(AppError::LlmApi(format!(
            "Rerank request exceeds the {} document limit",
            MAX_BATCH_ITEMS
        )));
    }
    let payload_bytes =
        total_text_bytes(std::iter::once(query).chain(documents.iter().map(String::as_str)));
    if payload_bytes > MAX_TEXT_PAYLOAD_BYTES {
        return Err(AppError::LlmApi(format!(
            "Rerank request exceeds the {} byte text limit",
            MAX_TEXT_PAYLOAD_BYTES
        )));
    }
    let top_n = top_n.unwrap_or(documents.len());
    if top_n == 0 || top_n > documents.len() {
        return Err(AppError::LlmApi(
            "Rerank topN must be between 1 and the document count".to_string(),
        ));
    }
    Ok(top_n)
}

fn total_text_bytes<'a>(values: impl Iterator<Item = &'a str>) -> usize {
    values.fold(0_usize, |total, value| total.saturating_add(value.len()))
}

fn fixed_endpoint(raw_endpoint: &str, service: &str) -> CommandResult<Url> {
    Url::parse(raw_endpoint).map_err(|_| {
        AppError::LlmApi(format!(
            "Internal {} endpoint configuration is invalid",
            service
        ))
    })
}

fn apply_bound_custom_auth(
    request: RequestBuilder,
    auth_mode: AuthMode,
    key_slot: &str,
    label: &str,
    endpoint: &Url,
) -> CommandResult<RequestBuilder> {
    match auth_mode {
        AuthMode::Bearer => {
            let api_key = required_bound_custom_api_key(key_slot, label, endpoint)?;
            Ok(request.bearer_auth(api_key))
        }
        AuthMode::None => Ok(request),
    }
}

fn embedding_key_slot(protocol: &str) -> CommandResult<&'static str> {
    match protocol {
        "openai" => Ok(CUSTOM_EMBEDDING_KEY_SLOT),
        "gemini" => Ok(GEMINI_EMBEDDING_KEY_SLOT),
        _ => Err(AppError::Keystore(
            "Unsupported custom Embedding credential protocol".to_string(),
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SafeHttpFailure {
    Status {
        status: StatusCode,
        retry_after_ms: Option<u64>,
    },
    Timeout,
    Connect,
    Request,
    ResponseRead,
    Decode,
}

/// Construct an IPC-safe external HTTP error.
///
/// This deliberately accepts no provider body, URL, request payload, or
/// parser detail, making it structurally impossible to echo those values to
/// renderer logs or user-visible errors.
fn safe_http_error(service: &str, failure: SafeHttpFailure) -> AppError {
    let message = match failure {
        SafeHttpFailure::Status {
            status,
            retry_after_ms,
        } => match retry_after_ms {
            Some(delay_ms) => format!(
                "{} returned HTTP {}; retry-after-ms={}",
                service,
                status.as_u16(),
                delay_ms
            ),
            None => format!("{} returned HTTP {}", service, status.as_u16()),
        },
        SafeHttpFailure::Timeout => format!("{} request failed (timeout)", service),
        SafeHttpFailure::Connect => format!("{} request failed (connect)", service),
        SafeHttpFailure::Request => format!("{} request failed (request)", service),
        SafeHttpFailure::ResponseRead => format!("{} response failed (read)", service),
        SafeHttpFailure::Decode => format!("{} response failed (decode)", service),
    };
    AppError::LlmApi(message)
}

fn safe_http_status_error(service: &str, response: &Response) -> AppError {
    safe_http_error(
        service,
        SafeHttpFailure::Status {
            status: response.status(),
            retry_after_ms: retry_after_ms(response.headers()),
        },
    )
}

/// Parse only bounded, derived retry timing metadata from an external response.
///
/// Raw header values are never included in IPC errors. `Retry-After` supports
/// both delta-seconds and HTTP-date; the commonly used `retry-after-ms` hint is
/// accepted as a fallback. When both are valid, the longer delay wins.
fn retry_after_ms(headers: &HeaderMap) -> Option<u64> {
    retry_after_ms_at(headers, Utc::now())
}

fn retry_after_ms_at(headers: &HeaderMap, now: DateTime<Utc>) -> Option<u64> {
    let standard_delay = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_retry_after_value_ms(value, now));
    let millisecond_delay = headers
        .get("retry-after-ms")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_unsigned_delay)
        .map(|delay| delay.min(MAX_RETRY_AFTER_MS));

    standard_delay.into_iter().chain(millisecond_delay).max()
}

fn parse_retry_after_value_ms(value: &str, now: DateTime<Utc>) -> Option<u64> {
    let value = value.trim();
    if let Some(seconds) = parse_unsigned_delay(value) {
        return Some(seconds.saturating_mul(1_000).min(MAX_RETRY_AFTER_MS));
    }

    let retry_at = DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&Utc);
    let delay_ms = retry_at.signed_duration_since(now).num_milliseconds();
    Some(
        u64::try_from(delay_ms.max(0))
            .unwrap_or(0)
            .min(MAX_RETRY_AFTER_MS),
    )
}

fn parse_unsigned_delay(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(value.bytes().fold(0_u64, |total, byte| {
        total
            .saturating_mul(10)
            .saturating_add(u64::from(byte - b'0'))
    }))
}

fn safe_request_error(service: &str, error: &reqwest::Error) -> AppError {
    let failure = if error.is_timeout() {
        SafeHttpFailure::Timeout
    } else if error.is_connect() {
        SafeHttpFailure::Connect
    } else {
        SafeHttpFailure::Request
    };
    safe_http_error(service, failure)
}

async fn parse_limited_json<T: DeserializeOwned>(
    response: Response,
    service: &str,
    max_bytes: usize,
) -> CommandResult<T> {
    if response
        .content_length()
        .map(|length| length > max_bytes as u64)
        .unwrap_or(false)
    {
        return Err(AppError::LlmApi(format!(
            "{} response exceeds the {} byte limit",
            service, max_bytes
        )));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| safe_http_error(service, SafeHttpFailure::ResponseRead))?;
        if chunk.len() > max_bytes.saturating_sub(body.len()) {
            return Err(AppError::LlmApi(format!(
                "{} response exceeds the {} byte limit",
                service, max_bytes
            )));
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body).map_err(|_| safe_http_error(service, SafeHttpFailure::Decode))
}

fn parse_embedding_response(
    response: OpenAiEmbeddingResponse,
    expected_count: usize,
    requested_model: &str,
) -> CommandResult<CloudEmbeddingResponse> {
    if response.data.len() != expected_count {
        return Err(AppError::LlmApi(format!(
            "Embedding response item count mismatch: expected {}, received {}",
            expected_count,
            response.data.len()
        )));
    }

    let indexed_count = response
        .data
        .iter()
        .filter(|item| item.index.is_some())
        .count();
    let embeddings = if indexed_count == 0 {
        response
            .data
            .into_iter()
            .map(|item| item.embedding)
            .collect::<Vec<_>>()
    } else if indexed_count == expected_count {
        let mut ordered: Vec<Option<Vec<f32>>> = vec![None; expected_count];
        for item in response.data {
            let index = item.index.ok_or_else(|| {
                AppError::LlmApi("Embedding response mixes indexed and unindexed items".to_string())
            })?;
            if index >= expected_count {
                return Err(AppError::LlmApi(format!(
                    "Embedding response index {} is out of range",
                    index
                )));
            }
            if ordered[index].replace(item.embedding).is_some() {
                return Err(AppError::LlmApi(format!(
                    "Embedding response contains duplicate index {}",
                    index
                )));
            }
        }
        ordered
            .into_iter()
            .enumerate()
            .map(|(index, embedding)| {
                embedding.ok_or_else(|| {
                    AppError::LlmApi(format!("Embedding response is missing index {}", index))
                })
            })
            .collect::<CommandResult<Vec<_>>>()?
    } else {
        return Err(AppError::LlmApi(
            "Embedding response mixes indexed and unindexed items".to_string(),
        ));
    };

    let dimension = validate_embeddings(&embeddings)?;
    let model = response
        .model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| requested_model.to_string());

    Ok(CloudEmbeddingResponse {
        embeddings,
        dimension,
        model,
    })
}

fn validate_embeddings(embeddings: &[Vec<f32>]) -> CommandResult<usize> {
    let Some(first) = embeddings.first() else {
        return Err(AppError::LlmApi(
            "Embedding response contains no vectors".to_string(),
        ));
    };
    if first.is_empty() {
        return Err(AppError::LlmApi(
            "Embedding response contains an empty vector".to_string(),
        ));
    }
    let dimension = first.len();
    for embedding in embeddings {
        if embedding.is_empty() {
            return Err(AppError::LlmApi(
                "Embedding response contains an empty vector".to_string(),
            ));
        }
        if embedding.len() != dimension {
            return Err(AppError::LlmApi(
                "Embedding response contains vectors with different dimensions".to_string(),
            ));
        }
        if embedding.iter().any(|value| !value.is_finite()) {
            return Err(AppError::LlmApi(
                "Embedding response contains a non-finite value".to_string(),
            ));
        }
    }
    Ok(dimension)
}

fn normalize_embeddings_l2(embeddings: &mut [Vec<f32>]) -> CommandResult<()> {
    for embedding in embeddings {
        let norm = embedding
            .iter()
            .map(|value| {
                let value = f64::from(*value);
                value * value
            })
            .sum::<f64>()
            .sqrt();
        if !norm.is_finite() || norm == 0.0 {
            return Err(AppError::LlmApi(
                "Gemini Embedding response contains a vector that cannot be normalized".to_string(),
            ));
        }
        for value in embedding {
            *value = (f64::from(*value) / norm) as f32;
        }
    }
    Ok(())
}

fn validate_nonzero_embedding_norms(embeddings: &[Vec<f32>]) -> CommandResult<()> {
    for embedding in embeddings {
        let squared_norm = embedding
            .iter()
            .map(|value| {
                let value = f64::from(*value);
                value * value
            })
            .sum::<f64>();
        if !squared_norm.is_finite() || squared_norm == 0.0 {
            return Err(AppError::LlmApi(
                "Gemini Embedding response contains a zero-norm vector".to_string(),
            ));
        }
    }
    Ok(())
}

fn parse_gemini_embedding_response(
    response: GeminiBatchEmbedResponse,
    expected_count: usize,
    expected_dimension: usize,
    model: GeminiModel,
) -> CommandResult<CloudEmbeddingResponse> {
    if response.embeddings.len() != expected_count {
        return Err(AppError::LlmApi(format!(
            "Gemini Embedding response item count mismatch: expected {}, received {}",
            expected_count,
            response.embeddings.len()
        )));
    }

    let mut embeddings = response
        .embeddings
        .into_iter()
        .map(|embedding| embedding.values)
        .collect::<Vec<_>>();
    let dimension = validate_embeddings(&embeddings)?;
    if dimension != expected_dimension {
        return Err(AppError::LlmApi(format!(
            "Gemini Embedding response dimension mismatch: expected {}, received {}",
            expected_dimension, dimension
        )));
    }
    validate_nonzero_embedding_norms(&embeddings)?;

    if model == GeminiModel::Embedding001 && dimension != 3072 {
        normalize_embeddings_l2(&mut embeddings)?;
        validate_embeddings(&embeddings)?;
    }

    Ok(CloudEmbeddingResponse {
        embeddings,
        dimension,
        model: model.id().to_string(),
    })
}

fn validate_rerank_results(
    mut results: Vec<CloudRerankResult>,
    document_count: usize,
    top_n: usize,
) -> CommandResult<Vec<CloudRerankResult>> {
    if results.is_empty() {
        return Err(AppError::LlmApi(
            "Rerank response contains no results".to_string(),
        ));
    }
    if results.len() > top_n {
        return Err(AppError::LlmApi(format!(
            "Rerank response returned more than the requested {} results",
            top_n
        )));
    }

    let mut seen = vec![false; document_count];
    for result in &results {
        if result.index >= document_count {
            return Err(AppError::LlmApi(format!(
                "Rerank response index {} is out of range",
                result.index
            )));
        }
        if seen[result.index] {
            return Err(AppError::LlmApi(format!(
                "Rerank response contains duplicate index {}",
                result.index
            )));
        }
        if !result.relevance_score.is_finite() {
            return Err(AppError::LlmApi(
                "Rerank response contains a non-finite score".to_string(),
            ));
        }
        seen[result.index] = true;
    }

    results.sort_by(|left, right| {
        right
            .relevance_score
            .partial_cmp(&left.relevance_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(results)
}

#[tauri::command]
pub async fn cloud_embedding_encode(
    _state: State<'_, AppState>,
    request: CloudEmbeddingRequest,
) -> CommandResult<CloudEmbeddingResponse> {
    validate_embedding_inputs(&request.texts)?;

    match request.provider.as_str() {
        SILICONFLOW_PROVIDER => {
            let api_key = required_api_key(SILICONFLOW_PROVIDER, "SiliconFlow")?;
            encode_openai_compatible(
                fixed_endpoint(
                    "https://api.siliconflow.cn/v1/embeddings",
                    "SiliconFlow Embedding",
                )?,
                Some(&api_key),
                request.model.as_deref().unwrap_or("BAAI/bge-m3"),
                &request.texts,
                "SiliconFlow Embedding API",
            )
            .await
        }
        ZHIPU_PROVIDER => {
            let api_key = required_api_key(ZHIPU_PROVIDER, "Zhipu")?;
            encode_with_zhipu(
                &api_key,
                request.model.as_deref().unwrap_or("Embedding-3-pro"),
                &request.texts,
            )
            .await
        }
        CUSTOM_PROVIDER => encode_with_custom(&request).await,
        provider => Err(AppError::LlmApi(format!(
            "Unsupported Embedding provider: {}",
            provider
        ))),
    }
}

async fn encode_with_custom(
    request: &CloudEmbeddingRequest,
) -> CommandResult<CloudEmbeddingResponse> {
    let model = validate_model(request.model.as_deref())?;
    let protocol = required_trimmed(request.protocol.as_deref(), "protocol")?;
    match protocol {
        "openai" => encode_with_custom_openai(request, model).await,
        "gemini" => encode_with_gemini(request, model).await,
        protocol => Err(AppError::LlmApi(format!(
            "Unsupported custom Embedding protocol: {}",
            protocol
        ))),
    }
}

async fn encode_with_custom_openai(
    request: &CloudEmbeddingRequest,
    model: &str,
) -> CommandResult<CloudEmbeddingResponse> {
    let endpoint = validate_custom_endpoint(required_trimmed(
        request.endpoint_url.as_deref(),
        "endpointUrl",
    )?)?;
    let auth_mode = parse_auth_mode(request.auth_mode.as_deref())?;
    validate_purpose(
        request.purpose.as_deref(),
        &["query", "document", "generic", "test"],
    )?;
    validate_profile_id(request.profile_id.as_deref())?;

    let request_builder = get_rag_client()
        .post(endpoint.clone())
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "input": &request.texts,
            "encoding_format": "float",
        }));
    let request_builder = apply_bound_custom_auth(
        request_builder,
        auth_mode,
        embedding_key_slot("openai")?,
        "Custom RAG Embedding",
        &endpoint,
    )?;
    send_embedding_request(
        request_builder,
        request.texts.len(),
        model,
        "Custom RAG Embedding API",
    )
    .await
}

async fn encode_with_gemini(
    request: &CloudEmbeddingRequest,
    raw_model: &str,
) -> CommandResult<CloudEmbeddingResponse> {
    let model = GeminiModel::parse(raw_model)?;
    validate_gemini_endpoint(request.endpoint_url.as_deref())?;
    validate_gemini_auth_mode(request.auth_mode.as_deref())?;
    let purpose = GeminiPurpose::parse(required_trimmed(request.purpose.as_deref(), "purpose")?)?;
    validate_profile_id(request.profile_id.as_deref())?;
    let output_dimensionality = validate_gemini_dimension(request.output_dimensionality)?;
    validate_gemini_batch_size(request.texts.len())?;
    let payload = build_gemini_batch_request(model, purpose, &request.texts, output_dimensionality);
    let body = serialize_gemini_batch_request(&payload)?;
    let api_key = required_api_key(embedding_key_slot("gemini")?, "Gemini Embedding")?;

    let service = "Google Gemini Embedding API";
    let response = get_rag_client()
        .post(gemini_batch_endpoint(model)?)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", api_key)
        .body(body)
        .send()
        .await
        .map_err(|error| safe_request_error(service, &error))?;
    if !response.status().is_success() {
        return Err(safe_http_status_error(service, &response));
    }
    let response: GeminiBatchEmbedResponse =
        parse_limited_json(response, service, MAX_GEMINI_EMBEDDING_RESPONSE_BYTES).await?;
    parse_gemini_embedding_response(response, request.texts.len(), output_dimensionality, model)
}

async fn encode_openai_compatible(
    endpoint: Url,
    api_key: Option<&str>,
    model: &str,
    texts: &[String],
    service: &str,
) -> CommandResult<CloudEmbeddingResponse> {
    let mut request = get_rag_client()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "input": texts,
            "encoding_format": "float",
        }));
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    send_embedding_request(request, texts.len(), model, service).await
}

async fn send_embedding_request(
    request: RequestBuilder,
    expected_count: usize,
    requested_model: &str,
    service: &str,
) -> CommandResult<CloudEmbeddingResponse> {
    let response = request
        .send()
        .await
        .map_err(|error| safe_request_error(service, &error))?;
    if !response.status().is_success() {
        return Err(safe_http_status_error(service, &response));
    }
    let result: OpenAiEmbeddingResponse =
        parse_limited_json(response, service, MAX_EMBEDDING_RESPONSE_BYTES).await?;
    parse_embedding_response(result, expected_count, requested_model)
}

async fn encode_with_zhipu(
    api_key: &str,
    model: &str,
    texts: &[String],
) -> CommandResult<CloudEmbeddingResponse> {
    let endpoint = fixed_endpoint(
        "https://open.bigmodel.cn/api/paas/v4/embeddings",
        "Zhipu Embedding",
    )?;
    let mut embeddings = Vec::with_capacity(texts.len());
    let mut response_model = model.to_string();

    for text in texts {
        let response = get_rag_client()
            .post(endpoint.clone())
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "model": model, "input": text }))
            .send()
            .await
            .map_err(|error| safe_request_error("Zhipu Embedding API", &error))?;
        if !response.status().is_success() {
            return Err(safe_http_status_error("Zhipu Embedding API", &response));
        }
        let result: OpenAiEmbeddingResponse = parse_limited_json(
            response,
            "Zhipu Embedding API",
            MAX_EMBEDDING_RESPONSE_BYTES,
        )
        .await?;
        let parsed = parse_embedding_response(result, 1, model)?;
        response_model = parsed.model;
        embeddings.extend(parsed.embeddings);
    }

    let dimension = validate_embeddings(&embeddings)?;
    Ok(CloudEmbeddingResponse {
        embeddings,
        dimension,
        model: response_model,
    })
}

#[tauri::command]
pub async fn cloud_rerank_documents(
    _state: State<'_, AppState>,
    request: CloudRerankRequest,
) -> CommandResult<CloudRerankResponse> {
    let top_n = validate_rerank_inputs(&request.query, &request.documents, request.top_n)?;
    match request.provider.as_str() {
        SILICONFLOW_PROVIDER => {
            let api_key = required_api_key(SILICONFLOW_PROVIDER, "SiliconFlow")?;
            rerank_jina_cohere(
                fixed_endpoint("https://api.siliconflow.cn/v1/rerank", "SiliconFlow Rerank")?,
                Some(&api_key),
                request
                    .model
                    .as_deref()
                    .unwrap_or("BAAI/bge-reranker-v2-m3"),
                &request.query,
                &request.documents,
                top_n,
                "SiliconFlow Rerank API",
            )
            .await
        }
        CUSTOM_PROVIDER => rerank_with_custom(&request, top_n).await,
        provider => Err(AppError::LlmApi(format!(
            "Unsupported Rerank provider: {}",
            provider
        ))),
    }
}

async fn rerank_with_custom(
    request: &CloudRerankRequest,
    top_n: usize,
) -> CommandResult<CloudRerankResponse> {
    let model = validate_model(request.model.as_deref())?;
    let endpoint = validate_custom_endpoint(required_trimmed(
        request.endpoint_url.as_deref(),
        "endpointUrl",
    )?)?;
    let protocol = required_trimmed(request.protocol.as_deref(), "protocol")?;
    let auth_mode = parse_auth_mode(request.auth_mode.as_deref())?;
    validate_purpose(request.purpose.as_deref(), &["rerank", "test"])?;
    if request.profile_id.is_some() {
        validate_profile_id(request.profile_id.as_deref())?;
    }

    let key = match auth_mode {
        AuthMode::Bearer => Some(required_bound_custom_api_key(
            CUSTOM_RERANKER_KEY_SLOT,
            "Custom RAG Reranker",
            &endpoint,
        )?),
        AuthMode::None => None,
    };
    match protocol {
        "jina_cohere" => {
            rerank_jina_cohere(
                endpoint,
                key.as_deref(),
                model,
                &request.query,
                &request.documents,
                top_n,
                "Custom RAG Rerank API",
            )
            .await
        }
        "voyage" => {
            rerank_voyage(
                endpoint,
                key.as_deref(),
                model,
                &request.query,
                &request.documents,
                top_n,
            )
            .await
        }
        protocol => Err(AppError::LlmApi(format!(
            "Unsupported custom Rerank protocol: {}",
            protocol
        ))),
    }
}

async fn rerank_jina_cohere(
    endpoint: Url,
    api_key: Option<&str>,
    model: &str,
    query: &str,
    documents: &[String],
    top_n: usize,
    service: &str,
) -> CommandResult<CloudRerankResponse> {
    let mut request = get_rag_client()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "query": query,
            "documents": documents,
            "return_documents": false,
            "top_n": top_n,
        }));
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| safe_request_error(service, &error))?;
    if !response.status().is_success() {
        return Err(safe_http_status_error(service, &response));
    }
    let response: JinaCohereRerankResponse =
        parse_limited_json(response, service, MAX_RERANK_RESPONSE_BYTES).await?;
    let results = validate_rerank_results(response.results, documents.len(), top_n)?;
    let response_model = response
        .model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| model.to_string());
    Ok(CloudRerankResponse {
        results,
        model: response_model,
    })
}

async fn rerank_voyage(
    endpoint: Url,
    api_key: Option<&str>,
    model: &str,
    query: &str,
    documents: &[String],
    top_n: usize,
) -> CommandResult<CloudRerankResponse> {
    let service = "Custom Voyage Rerank API";
    let mut request = get_rag_client()
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "query": query,
            "documents": documents,
            "top_k": top_n,
            "return_documents": false,
        }));
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| safe_request_error(service, &error))?;
    if !response.status().is_success() {
        return Err(safe_http_status_error(service, &response));
    }
    let response: VoyageRerankResponse =
        parse_limited_json(response, service, MAX_RERANK_RESPONSE_BYTES).await?;
    let results = validate_rerank_results(response.data, documents.len(), top_n)?;
    let response_model = response
        .model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| model.to_string());
    Ok(CloudRerankResponse {
        results,
        model: response_model,
    })
}

#[tauri::command]
pub async fn cloud_embedding_list_providers(
    _state: State<'_, AppState>,
) -> CommandResult<Vec<String>> {
    Ok(vec![
        SILICONFLOW_PROVIDER.to_string(),
        CUSTOM_PROVIDER.to_string(),
        ZHIPU_PROVIDER.to_string(),
    ])
}

#[tauri::command]
pub async fn cloud_embedding_list_models(
    _state: State<'_, AppState>,
    provider: String,
) -> CommandResult<Vec<String>> {
    Ok(match provider.as_str() {
        SILICONFLOW_PROVIDER => vec!["BAAI/bge-m3".to_string()],
        ZHIPU_PROVIDER => vec!["Embedding-3-pro".to_string(), "Embedding-2".to_string()],
        CUSTOM_PROVIDER => Vec::new(),
        _ => Vec::new(),
    })
}

#[tauri::command]
pub async fn set_siliconflow_api_key(
    _state: State<'_, AppState>,
    api_key: String,
) -> CommandResult<()> {
    if api_key.trim().is_empty() {
        return Err(AppError::Keystore(
            "SiliconFlow API key must not be empty".to_string(),
        ));
    }
    WindowsKeystore::new().store_api_key(SILICONFLOW_PROVIDER, api_key.trim())?;
    Ok(())
}

#[tauri::command]
pub async fn get_siliconflow_api_key_status(_state: State<'_, AppState>) -> CommandResult<bool> {
    Ok(WindowsKeystore::new()
        .has_api_key(SILICONFLOW_PROVIDER)
        .unwrap_or(false))
}

fn custom_key_slot(kind: &str) -> CommandResult<&'static str> {
    match kind {
        "embedding" => Ok(CUSTOM_EMBEDDING_KEY_SLOT),
        "gemini_embedding" => Ok(GEMINI_EMBEDDING_KEY_SLOT),
        "reranker" => Ok(CUSTOM_RERANKER_KEY_SLOT),
        _ => Err(AppError::Keystore(
            "Custom RAG key kind must be embedding, gemini_embedding, or reranker".to_string(),
        )),
    }
}

#[tauri::command]
pub async fn set_custom_rag_api_key(
    _state: State<'_, AppState>,
    kind: String,
    api_key: String,
    endpoint_url: Option<String>,
) -> CommandResult<()> {
    let slot = custom_key_slot(&kind)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Keystore(
            "Custom RAG API key must not be empty".to_string(),
        ));
    }
    let stored = if kind == "gemini_embedding" {
        api_key.to_string()
    } else {
        let endpoint =
            validate_custom_endpoint(required_trimmed(endpoint_url.as_deref(), "endpointUrl")?)?;
        serialize_bound_custom_credential(&endpoint, api_key)?
    };
    WindowsKeystore::new().store_api_key(slot, &stored)?;
    Ok(())
}

#[tauri::command]
pub async fn get_custom_rag_credential_status(
    _state: State<'_, AppState>,
    kind: String,
    endpoint_url: Option<String>,
) -> CommandResult<CustomRagCredentialStatus> {
    let stored = WindowsKeystore::new().get_api_key(custom_key_slot(&kind)?)?;
    let state = if kind == "gemini_embedding" {
        if stored
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            CustomRagCredentialState::Bound
        } else {
            CustomRagCredentialState::Missing
        }
    } else {
        bound_custom_credential_state(stored.as_deref(), endpoint_url.as_deref())
    };
    Ok(CustomRagCredentialStatus { state })
}

#[tauri::command]
pub async fn delete_custom_rag_api_key(
    _state: State<'_, AppState>,
    kind: String,
) -> CommandResult<()> {
    WindowsKeystore::new().delete_api_key(custom_key_slot(&kind)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embedding_item(index: Option<usize>, values: &[f32]) -> OpenAiEmbeddingData {
        OpenAiEmbeddingData {
            embedding: values.to_vec(),
            index,
        }
    }

    #[test]
    fn external_http_errors_expose_only_stable_safe_categories() {
        let service = "Custom RAG Embedding API";
        let cases = [
            (
                SafeHttpFailure::Status {
                    status: StatusCode::BAD_REQUEST,
                    retry_after_ms: None,
                },
                "LLM API call failed: Custom RAG Embedding API returned HTTP 400",
            ),
            (
                SafeHttpFailure::Timeout,
                "LLM API call failed: Custom RAG Embedding API request failed (timeout)",
            ),
            (
                SafeHttpFailure::Connect,
                "LLM API call failed: Custom RAG Embedding API request failed (connect)",
            ),
            (
                SafeHttpFailure::Request,
                "LLM API call failed: Custom RAG Embedding API request failed (request)",
            ),
            (
                SafeHttpFailure::ResponseRead,
                "LLM API call failed: Custom RAG Embedding API response failed (read)",
            ),
            (
                SafeHttpFailure::Decode,
                "LLM API call failed: Custom RAG Embedding API response failed (decode)",
            ),
        ];
        let untrusted_fragments = [
            "provider-body-secret",
            "https://user:password@example.com/v1/embeddings?token=secret",
            "super-secret-api-key",
            "private query text",
        ];

        for (failure, expected) in cases {
            let rendered = safe_http_error(service, failure).to_string();
            assert_eq!(rendered, expected);
            for fragment in untrusted_fragments {
                assert!(!rendered.contains(fragment));
            }
        }

        let rendered = safe_http_error(
            service,
            SafeHttpFailure::Status {
                status: StatusCode::TOO_MANY_REQUESTS,
                retry_after_ms: Some(MAX_RETRY_AFTER_MS),
            },
        )
        .to_string();
        assert_eq!(
            rendered,
            "LLM API call failed: Custom RAG Embedding API returned HTTP 429; retry-after-ms=120000"
        );
        for fragment in untrusted_fragments {
            assert!(!rendered.contains(fragment));
        }
    }

    #[test]
    fn retry_after_headers_are_converted_to_bounded_milliseconds() {
        use reqwest::header::HeaderValue;

        let now = DateTime::parse_from_rfc3339("2015-10-21T07:28:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("3"));
        assert_eq!(retry_after_ms_at(&headers, now), Some(3_000));

        headers.clear();
        headers.insert("retry-after-ms", HeaderValue::from_static("1500"));
        assert_eq!(retry_after_ms_at(&headers, now), Some(1_500));

        headers.insert(RETRY_AFTER, HeaderValue::from_static("2"));
        assert_eq!(retry_after_ms_at(&headers, now), Some(2_000));

        headers.insert("retry-after-ms", HeaderValue::from_static("5000"));
        assert_eq!(retry_after_ms_at(&headers, now), Some(5_000));

        headers.clear();
        headers.insert(
            RETRY_AFTER,
            HeaderValue::from_static("Wed, 21 Oct 2015 07:28:30 GMT"),
        );
        assert_eq!(retry_after_ms_at(&headers, now), Some(30_000));

        headers.clear();
        headers.insert(
            RETRY_AFTER,
            HeaderValue::from_static("999999999999999999999999"),
        );
        headers.insert(
            "retry-after-ms",
            HeaderValue::from_static("999999999999999999999999"),
        );
        assert_eq!(retry_after_ms_at(&headers, now), Some(MAX_RETRY_AFTER_MS));
    }

    #[test]
    fn invalid_retry_after_headers_are_ignored_without_echoing_them() {
        use reqwest::header::HeaderValue;

        let now = DateTime::parse_from_rfc3339("2015-10-21T07:28:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut headers = HeaderMap::new();
        headers.insert(
            RETRY_AFTER,
            HeaderValue::from_static("provider-body-secret"),
        );
        headers.insert("retry-after-ms", HeaderValue::from_static("-1"));

        assert_eq!(retry_after_ms_at(&headers, now), None);
        let rendered = safe_http_error(
            "Custom RAG Embedding API",
            SafeHttpFailure::Status {
                status: StatusCode::TOO_MANY_REQUESTS,
                retry_after_ms: retry_after_ms_at(&headers, now),
            },
        )
        .to_string();
        assert_eq!(
            rendered,
            "LLM API call failed: Custom RAG Embedding API returned HTTP 429"
        );
        assert!(!rendered.contains("provider-body-secret"));
    }

    #[test]
    fn custom_endpoint_accepts_https_and_loopback_http() {
        assert!(validate_custom_endpoint("https://example.com/v1/embeddings").is_ok());
        assert!(validate_custom_endpoint("http://localhost:11434/v1/embeddings").is_ok());
        assert!(validate_custom_endpoint("http://127.0.0.1:11434/v1/embeddings").is_ok());
        assert!(validate_custom_endpoint("http://[::1]:11434/v1/embeddings").is_ok());
    }

    #[test]
    fn custom_endpoint_rejects_unsafe_urls() {
        assert!(validate_custom_endpoint("http://example.com/v1/embeddings").is_err());
        assert!(validate_custom_endpoint("ftp://example.com/file").is_err());
        assert!(validate_custom_endpoint("https://user:secret@example.com/v1/embeddings").is_err());
        assert!(validate_custom_endpoint("https://example.com/v1/embeddings#fragment").is_err());
        assert!(validate_custom_endpoint("not a URL").is_err());
    }

    #[test]
    fn ipc_requests_use_the_documented_camel_case_contract() {
        let embedding: CloudEmbeddingRequest = serde_json::from_value(serde_json::json!({
            "provider": "custom",
            "model": "embed-model",
            "texts": ["text"],
            "endpointUrl": "https://example.com/v1/embeddings",
            "protocol": "openai",
            "authMode": "bearer",
            "purpose": "document",
            "profileId": "rag-embedding:v1:custom:test",
            "outputDimensionality": 768
        }))
        .unwrap();
        assert_eq!(
            embedding.endpoint_url.as_deref(),
            Some("https://example.com/v1/embeddings")
        );
        assert_eq!(embedding.auth_mode.as_deref(), Some("bearer"));
        assert_eq!(
            embedding.profile_id.as_deref(),
            Some("rag-embedding:v1:custom:test")
        );
        assert_eq!(embedding.output_dimensionality, Some(768));

        let rerank: CloudRerankRequest = serde_json::from_value(serde_json::json!({
            "provider": "custom",
            "model": "rerank-model",
            "query": "query",
            "documents": ["document"],
            "topN": 1,
            "endpointUrl": "https://example.com/v1/rerank",
            "protocol": "voyage",
            "authMode": "none",
            "purpose": "test"
        }))
        .unwrap();
        assert_eq!(rerank.top_n, Some(1));
        assert_eq!(rerank.protocol.as_deref(), Some("voyage"));
    }

    #[test]
    fn custom_credentials_are_limited_to_fixed_slots() {
        assert_eq!(
            custom_key_slot("embedding").unwrap(),
            CUSTOM_EMBEDDING_KEY_SLOT
        );
        assert_eq!(
            custom_key_slot("gemini_embedding").unwrap(),
            GEMINI_EMBEDDING_KEY_SLOT
        );
        assert_eq!(
            custom_key_slot("reranker").unwrap(),
            CUSTOM_RERANKER_KEY_SLOT
        );
        assert!(custom_key_slot("openai").is_err());
        assert!(custom_key_slot("siliconflow").is_err());
    }

    #[test]
    fn custom_credentials_are_bound_to_the_endpoint_origin() {
        let endpoint = validate_custom_endpoint("https://api.example.com/v1/embeddings").unwrap();
        let stored = serialize_bound_custom_credential(&endpoint, "secret-openai-key").unwrap();

        assert_eq!(
            bound_custom_credential_state(
                Some(&stored),
                Some("https://api.example.com/other/embedding-path")
            ),
            CustomRagCredentialState::Bound
        );
        assert_eq!(
            bound_custom_credential_state(Some(&stored), Some("https://api.jina.ai/v1/embeddings")),
            CustomRagCredentialState::DifferentEndpoint
        );
        assert_eq!(
            bound_custom_api_key_from_stored(&stored, "Custom RAG Embedding", &endpoint).unwrap(),
            "secret-openai-key"
        );
    }

    #[test]
    fn legacy_or_different_endpoint_credentials_are_never_returned_for_requests() {
        let openai_endpoint =
            validate_custom_endpoint("https://api.openai.com/v1/embeddings").unwrap();
        let jina_endpoint = validate_custom_endpoint("https://api.jina.ai/v1/embeddings").unwrap();
        let stored =
            serialize_bound_custom_credential(&openai_endpoint, "secret-openai-key").unwrap();

        let mismatch =
            bound_custom_api_key_from_stored(&stored, "Custom RAG Embedding", &jina_endpoint)
                .unwrap_err()
                .to_string();
        assert!(mismatch.contains("different endpoint"));
        assert!(!mismatch.contains("secret-openai-key"));
        assert!(!mismatch.contains("api.openai.com"));
        assert!(!mismatch.contains("api.jina.ai"));

        let legacy = bound_custom_api_key_from_stored(
            "legacy-raw-api-key",
            "Custom RAG Embedding",
            &openai_endpoint,
        )
        .unwrap_err()
        .to_string();
        assert!(legacy.contains("saved again"));
        assert!(!legacy.contains("legacy-raw-api-key"));
        assert_eq!(
            bound_custom_credential_state(
                Some("legacy-raw-api-key"),
                Some("https://api.openai.com/v1/embeddings")
            ),
            CustomRagCredentialState::Legacy
        );
    }

    #[test]
    fn embedding_protocols_use_separate_fixed_key_slots() {
        assert_eq!(
            embedding_key_slot("openai").unwrap(),
            CUSTOM_EMBEDDING_KEY_SLOT
        );
        assert_eq!(
            embedding_key_slot("gemini").unwrap(),
            GEMINI_EMBEDDING_KEY_SLOT
        );
        assert!(embedding_key_slot("unknown").is_err());
    }

    #[test]
    fn gemini_endpoint_is_restricted_to_the_canonical_api_base() {
        assert!(validate_gemini_endpoint(Some(GEMINI_API_BASE)).is_ok());
        assert!(validate_gemini_endpoint(Some(
            "https://generativelanguage.googleapis.com/v1beta/"
        ))
        .is_ok());

        for endpoint in [
            "http://generativelanguage.googleapis.com/v1beta",
            "https://generativelanguage.googleapis.com",
            "https://generativelanguage.googleapis.com/v1",
            "https://generativelanguage.googleapis.com/v1beta?key=secret",
            "https://generativelanguage.googleapis.com:443/v1beta",
            "https://example.com/v1beta",
        ] {
            assert!(validate_gemini_endpoint(Some(endpoint)).is_err());
        }
        assert!(validate_gemini_endpoint(None).is_err());
    }

    #[test]
    fn gemini_endpoint_and_options_are_allowlisted() {
        let endpoint = gemini_batch_endpoint(GeminiModel::Embedding001).unwrap();
        assert_eq!(
            endpoint.as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents"
        );
        assert_eq!(
            GeminiModel::parse(GEMINI_EMBEDDING_2).unwrap(),
            GeminiModel::Embedding2
        );
        assert!(GeminiModel::parse("models/gemini-embedding-2").is_err());
        assert!(GeminiModel::parse("text-embedding-004").is_err());
        assert!(validate_gemini_auth_mode(Some("google_api_key")).is_ok());
        assert!(validate_gemini_auth_mode(Some("bearer")).is_err());
        assert_eq!(validate_gemini_dimension(Some(768)).unwrap(), 768);
        assert_eq!(validate_gemini_dimension(Some(1536)).unwrap(), 1536);
        assert_eq!(validate_gemini_dimension(Some(3072)).unwrap(), 3072);
        assert!(validate_gemini_dimension(Some(1024)).is_err());
        assert!(validate_gemini_dimension(None).is_err());
        assert!(validate_gemini_batch_size(1).is_ok());
        assert!(validate_gemini_batch_size(MAX_GEMINI_BATCH_ITEMS).is_ok());
        assert!(validate_gemini_batch_size(0).is_err());
        assert!(validate_gemini_batch_size(MAX_GEMINI_BATCH_ITEMS + 1).is_err());
    }

    #[test]
    fn gemini_001_payload_maps_purpose_to_task_type_without_rewriting_text() {
        let texts = vec!["original text".to_string()];
        let payload = build_gemini_batch_request(
            GeminiModel::Embedding001,
            GeminiPurpose::Document,
            &texts,
            768,
        );
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["requests"][0]["model"], "models/gemini-embedding-001");
        assert_eq!(
            json["requests"][0]["content"]["parts"][0]["text"],
            "original text"
        );
        assert_eq!(json["requests"][0]["taskType"], "RETRIEVAL_DOCUMENT");
        assert_eq!(json["requests"][0]["outputDimensionality"], 768);

        assert_eq!(
            gemini_task_type(GeminiModel::Embedding001, GeminiPurpose::Query),
            Some("RETRIEVAL_QUERY")
        );
        assert_eq!(
            gemini_task_type(GeminiModel::Embedding001, GeminiPurpose::Generic),
            Some("SEMANTIC_SIMILARITY")
        );
        assert_eq!(
            gemini_task_type(GeminiModel::Embedding001, GeminiPurpose::Test),
            Some("RETRIEVAL_QUERY")
        );
    }

    #[test]
    fn gemini_2_payload_uses_purpose_prefixes_without_task_type() {
        let cases = [
            (GeminiPurpose::Query, "task: search result | query: hello"),
            (GeminiPurpose::Test, "task: search result | query: hello"),
            (GeminiPurpose::Document, "title: none | text: hello"),
            (
                GeminiPurpose::Generic,
                "task: sentence similarity | query: hello",
            ),
        ];

        for (purpose, expected_text) in cases {
            let payload = build_gemini_batch_request(
                GeminiModel::Embedding2,
                purpose,
                &["hello".to_string()],
                1536,
            );
            let json = serde_json::to_value(payload).unwrap();
            assert_eq!(json["requests"][0]["model"], "models/gemini-embedding-2");
            assert_eq!(
                json["requests"][0]["content"]["parts"][0]["text"],
                expected_text
            );
            assert!(json["requests"][0].get("taskType").is_none());
            assert_eq!(json["requests"][0]["outputDimensionality"], 1536);
        }
    }

    #[test]
    fn gemini_serialized_body_limit_accounts_for_json_escaping() {
        let escaping_text = "\0".repeat(MAX_GEMINI_REQUEST_BODY_BYTES / 6 + 1);
        let texts = vec![escaping_text];
        assert!(total_text_bytes(texts.iter().map(String::as_str)) < MAX_TEXT_PAYLOAD_BYTES);
        validate_embedding_inputs(&texts).unwrap();

        let payload = build_gemini_batch_request(
            GeminiModel::Embedding001,
            GeminiPurpose::Document,
            &texts,
            768,
        );
        let error = serialize_gemini_batch_request(&payload)
            .unwrap_err()
            .to_string();
        assert!(error.contains("serialized body limit"));

        let small_payload = build_gemini_batch_request(
            GeminiModel::Embedding2,
            GeminiPurpose::Query,
            &["hello".to_string()],
            768,
        );
        assert!(!serialize_gemini_batch_request(&small_payload)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn gemini_response_limit_is_dedicated_and_covers_the_allowlisted_shape() {
        const GENEROUS_JSON_BYTES_PER_FLOAT: usize = 32;
        let generous_max_vector_body =
            MAX_GEMINI_BATCH_ITEMS * 3072 * GENEROUS_JSON_BYTES_PER_FLOAT;

        assert!(MAX_GEMINI_EMBEDDING_RESPONSE_BYTES >= generous_max_vector_body);
        assert!(MAX_GEMINI_EMBEDDING_RESPONSE_BYTES < MAX_EMBEDDING_RESPONSE_BYTES);
    }

    #[test]
    fn gemini_parser_validates_response_and_normalizes_truncated_001_vectors() {
        let response = parse_gemini_embedding_response(
            GeminiBatchEmbedResponse {
                embeddings: vec![GeminiEmbedding {
                    values: vec![3.0, 4.0],
                }],
            },
            1,
            2,
            GeminiModel::Embedding001,
        )
        .unwrap();
        assert!((response.embeddings[0][0] - 0.6).abs() < 1e-6);
        assert!((response.embeddings[0][1] - 0.8).abs() < 1e-6);
        assert_eq!(response.dimension, 2);
        assert_eq!(response.model, GEMINI_EMBEDDING_001);

        let embedding_2 = parse_gemini_embedding_response(
            GeminiBatchEmbedResponse {
                embeddings: vec![GeminiEmbedding {
                    values: vec![3.0, 4.0],
                }],
            },
            1,
            2,
            GeminiModel::Embedding2,
        )
        .unwrap();
        assert_eq!(embedding_2.embeddings[0], vec![3.0, 4.0]);
    }

    #[test]
    fn gemini_parser_rejects_bad_counts_dimensions_values_and_zero_norm() {
        let parse = |values: Vec<Vec<f32>>, expected_count, expected_dimension| {
            parse_gemini_embedding_response(
                GeminiBatchEmbedResponse {
                    embeddings: values
                        .into_iter()
                        .map(|values| GeminiEmbedding { values })
                        .collect(),
                },
                expected_count,
                expected_dimension,
                GeminiModel::Embedding001,
            )
        };

        assert!(parse(vec![vec![1.0]], 2, 1).is_err());
        assert!(parse(vec![vec![1.0, 2.0]], 1, 1).is_err());
        assert!(parse(vec![vec![1.0], vec![1.0, 2.0]], 2, 1).is_err());
        assert!(parse(vec![vec![f32::NAN]], 1, 1).is_err());
        assert!(parse(vec![vec![0.0, 0.0]], 1, 2).is_err());

        for (model, dimension) in [
            (GeminiModel::Embedding001, 3072),
            (GeminiModel::Embedding2, 768),
            (GeminiModel::Embedding2, 3072),
        ] {
            assert!(parse_gemini_embedding_response(
                GeminiBatchEmbedResponse {
                    embeddings: vec![GeminiEmbedding {
                        values: vec![0.0; dimension],
                    }],
                },
                1,
                dimension,
                model,
            )
            .is_err());
        }
    }

    #[test]
    fn embedding_parser_orders_fully_indexed_items() {
        let response = parse_embedding_response(
            OpenAiEmbeddingResponse {
                data: vec![
                    embedding_item(Some(1), &[0.0, 1.0]),
                    embedding_item(Some(0), &[1.0, 0.0]),
                ],
                model: Some("response-model".to_string()),
            },
            2,
            "request-model",
        )
        .unwrap();

        assert_eq!(response.embeddings[0], vec![1.0, 0.0]);
        assert_eq!(response.embeddings[1], vec![0.0, 1.0]);
        assert_eq!(response.dimension, 2);
        assert_eq!(response.model, "response-model");
    }

    #[test]
    fn embedding_parser_preserves_fully_unindexed_order() {
        let response = parse_embedding_response(
            OpenAiEmbeddingResponse {
                data: vec![
                    embedding_item(None, &[1.0, 0.0]),
                    embedding_item(None, &[0.0, 1.0]),
                ],
                model: None,
            },
            2,
            "request-model",
        )
        .unwrap();

        assert_eq!(response.embeddings[0], vec![1.0, 0.0]);
        assert_eq!(response.embeddings[1], vec![0.0, 1.0]);
        assert_eq!(response.model, "request-model");
    }

    #[test]
    fn embedding_parser_rejects_bad_indices_and_vectors() {
        let parse = |data| {
            parse_embedding_response(OpenAiEmbeddingResponse { data, model: None }, 2, "model")
        };

        assert!(parse(vec![
            embedding_item(Some(0), &[1.0]),
            embedding_item(None, &[1.0]),
        ])
        .is_err());
        assert!(parse(vec![
            embedding_item(Some(0), &[1.0]),
            embedding_item(Some(0), &[1.0]),
        ])
        .is_err());
        assert!(parse(vec![
            embedding_item(Some(0), &[1.0]),
            embedding_item(Some(2), &[1.0]),
        ])
        .is_err());
        assert!(parse(vec![
            embedding_item(None, &[1.0]),
            embedding_item(None, &[]),
        ])
        .is_err());
        assert!(parse(vec![
            embedding_item(None, &[1.0]),
            embedding_item(None, &[1.0, 2.0]),
        ])
        .is_err());
        assert!(parse(vec![
            embedding_item(None, &[1.0]),
            embedding_item(None, &[f32::NAN]),
        ])
        .is_err());
    }

    #[test]
    fn rerank_parser_rejects_invalid_indices_and_scores() {
        assert!(validate_rerank_results(
            vec![CloudRerankResult {
                index: 2,
                relevance_score: 0.5,
            }],
            2,
            1,
        )
        .is_err());
        assert!(validate_rerank_results(
            vec![
                CloudRerankResult {
                    index: 0,
                    relevance_score: 0.5,
                },
                CloudRerankResult {
                    index: 0,
                    relevance_score: 0.4,
                },
            ],
            2,
            2,
        )
        .is_err());
        assert!(validate_rerank_results(
            vec![CloudRerankResult {
                index: 0,
                relevance_score: f32::INFINITY,
            }],
            1,
            1,
        )
        .is_err());
    }
}
