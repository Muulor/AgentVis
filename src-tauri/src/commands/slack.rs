//! Slack HTTP API 代理命令
//!
//! 将 Slack Web API 与文件下载/上传调用代理到 Rust 后端，供前端 IM 通道和 slack_send 工具复用。

use base64::{engine::general_purpose::STANDARD as BASE64_ENGINE, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::error::CommandResult;
use crate::AppState;

const SLACK_API_BASE: &str = "https://slack.com/api";

fn format_reqwest_error(context: &str, error: reqwest::Error) -> crate::error::AppError {
    let mut flags = Vec::new();
    if error.is_timeout() {
        flags.push("timeout");
    }
    if error.is_connect() {
        flags.push("connect");
    }
    if error.is_request() {
        flags.push("request");
    }
    if error.is_body() {
        flags.push("body");
    }
    let detail = if flags.is_empty() {
        error.to_string()
    } else {
        format!("{} [{}]", error, flags.join(","))
    };
    crate::error::AppError::Generic(format!("{}: {}", context, detail))
}

#[derive(Debug, Deserialize)]
struct SlackGenericResponse {
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackAuthTestResponse {
    ok: bool,
    user_id: Option<String>,
    bot_id: Option<String>,
    team_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackAuthTestResult {
    pub user_id: String,
    pub bot_id: String,
    pub team_id: String,
}

#[derive(Debug, Deserialize)]
struct SlackOpenSocketResponse {
    ok: bool,
    url: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackSocketResult {
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct SlackPostMessageResponse {
    ok: bool,
    channel: Option<String>,
    ts: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackMessageResult {
    pub channel: String,
    pub ts: String,
}

#[derive(Debug, Deserialize)]
struct SlackDeleteMessageResponse {
    ok: bool,
    channel: Option<String>,
    ts: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SlackUploadUrlResponse {
    ok: bool,
    upload_url: Option<String>,
    file_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackUploadResult {
    pub file_id: String,
    pub channel: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackDownloadResult {
    pub base64: String,
    pub mime_type: String,
}

#[tauri::command]
pub async fn slack_open_socket_connection(
    _state: State<'_, AppState>,
    app_token: String,
) -> CommandResult<SlackSocketResult> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/apps.connections.open", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", app_token))
        .header("Content-Type", "application/json; charset=utf-8")
        .send()
        .await
        .map_err(|e| format_reqwest_error("Slack socket open request failed", e))?;

    let result: SlackOpenSocketResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Slack socket response: {}", e))
    })?;

    if !result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to open Slack Socket Mode connection: {}",
            result.error.unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    let url = result.url.ok_or_else(|| {
        crate::error::AppError::Generic("Slack socket response is missing url".to_string())
    })?;

    Ok(SlackSocketResult { url })
}

#[tauri::command]
pub async fn slack_auth_test(
    _state: State<'_, AppState>,
    bot_token: String,
) -> CommandResult<SlackAuthTestResult> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/auth.test", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", bot_token))
        .header("Content-Type", "application/json; charset=utf-8")
        .send()
        .await
        .map_err(|e| format_reqwest_error("Slack auth.test request failed", e))?;

    let result: SlackAuthTestResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Slack auth.test response: {}", e))
    })?;

    if !result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Slack auth.test failed: {}",
            result.error.unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    Ok(SlackAuthTestResult {
        user_id: result.user_id.unwrap_or_default(),
        bot_id: result.bot_id.unwrap_or_default(),
        team_id: result.team_id.unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn slack_post_message(
    _state: State<'_, AppState>,
    bot_token: String,
    channel: String,
    text: String,
    blocks: Option<serde_json::Value>,
    thread_ts: Option<String>,
) -> CommandResult<SlackMessageResult> {
    let client = reqwest::Client::new();
    let mut body = serde_json::json!({
        "channel": channel,
        "text": text,
    });
    if let Some(blocks) = blocks {
        body["blocks"] = blocks;
    }
    if let Some(thread_ts) = thread_ts.filter(|v| !v.trim().is_empty()) {
        body["thread_ts"] = serde_json::Value::String(thread_ts);
    }

    let response = client
        .post(format!("{}/chat.postMessage", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", bot_token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_reqwest_error("Failed to send Slack message", e))?;

    let result: SlackPostMessageResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Slack message response: {}", e))
    })?;

    if !result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to send Slack message: {}",
            result.error.unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    Ok(SlackMessageResult {
        channel: result.channel.unwrap_or_default(),
        ts: result.ts.unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn slack_update_message(
    _state: State<'_, AppState>,
    bot_token: String,
    channel: String,
    ts: String,
    text: String,
    blocks: Option<serde_json::Value>,
) -> CommandResult<SlackMessageResult> {
    let client = reqwest::Client::new();
    let mut body = serde_json::json!({
        "channel": channel,
        "ts": ts,
        "text": text,
    });
    if let Some(blocks) = blocks {
        body["blocks"] = blocks;
    }

    let response = client
        .post(format!("{}/chat.update", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", bot_token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| format_reqwest_error("Failed to update Slack message", e))?;

    let result: SlackPostMessageResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Slack update response: {}", e))
    })?;

    if !result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to update Slack message: {}",
            result.error.unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    Ok(SlackMessageResult {
        channel: result.channel.unwrap_or_default(),
        ts: result.ts.unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn slack_upload_file_external(
    _state: State<'_, AppState>,
    bot_token: String,
    channel: String,
    file_base64: String,
    file_name: String,
    mime_type: Option<String>,
    title: Option<String>,
    initial_comment: Option<String>,
) -> CommandResult<SlackUploadResult> {
    let file_bytes = BASE64_ENGINE.decode(&file_base64).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to decode Slack file base64: {}", e))
    })?;
    let file_length = file_bytes.len();

    let client = reqwest::Client::new();
    let upload_url_form = vec![
        ("filename", file_name.clone()),
        ("length", file_length.to_string()),
    ];
    let upload_url_response = client
        .post(format!("{}/files.getUploadURLExternal", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", bot_token))
        .form(&upload_url_form)
        .send()
        .await
        .map_err(|e| format_reqwest_error("Slack getUploadURLExternal request failed", e))?;

    let upload_url_result: SlackUploadUrlResponse =
        upload_url_response.json().await.map_err(|e| {
            crate::error::AppError::Generic(format!(
                "Failed to parse Slack upload URL response: {}",
                e
            ))
        })?;

    if !upload_url_result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Slack getUploadURLExternal failed: {}",
            upload_url_result
                .error
                .unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    let upload_url = upload_url_result.upload_url.ok_or_else(|| {
        crate::error::AppError::Generic(
            "Slack upload URL response is missing upload_url".to_string(),
        )
    })?;
    let file_id = upload_url_result.file_id.ok_or_else(|| {
        crate::error::AppError::Generic("Slack upload URL response is missing file_id".to_string())
    })?;

    let upload_response = client
        .post(upload_url)
        .header(
            "Content-Type",
            mime_type.as_deref().unwrap_or("application/octet-stream"),
        )
        .header("Content-Length", file_length.to_string())
        .body(file_bytes)
        .send()
        .await
        .map_err(|e| format_reqwest_error("Slack external file upload failed", e))?;
    if !upload_response.status().is_success() {
        return Err(crate::error::AppError::Generic(format!(
            "Slack external file upload failed, HTTP status: {}",
            upload_response.status().as_u16()
        )));
    }

    let files_value = serde_json::json!([{
        "id": file_id.clone(),
        "title": title.unwrap_or(file_name),
    }])
    .to_string();
    let mut complete_form = vec![("files", files_value), ("channel_id", channel.clone())];
    if let Some(comment) = initial_comment.filter(|value| !value.trim().is_empty()) {
        complete_form.push(("initial_comment", comment));
    }

    let complete_response = client
        .post(format!("{}/files.completeUploadExternal", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", bot_token))
        .form(&complete_form)
        .send()
        .await
        .map_err(|e| format_reqwest_error("Slack completeUploadExternal request failed", e))?;

    let complete_result: SlackGenericResponse = complete_response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!(
            "Failed to parse Slack complete upload response: {}",
            e
        ))
    })?;

    if !complete_result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Slack completeUploadExternal failed: {}",
            complete_result
                .error
                .unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    Ok(SlackUploadResult { file_id, channel })
}

#[tauri::command]
pub async fn slack_delete_message(
    _state: State<'_, AppState>,
    bot_token: String,
    channel: String,
    ts: String,
) -> CommandResult<SlackMessageResult> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/chat.delete", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", bot_token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&serde_json::json!({
            "channel": channel,
            "ts": ts,
        }))
        .send()
        .await
        .map_err(|e| format_reqwest_error("Failed to delete Slack message", e))?;

    let result: SlackDeleteMessageResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Slack delete response: {}", e))
    })?;

    if !result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to delete Slack message: {}",
            result.error.unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    Ok(SlackMessageResult {
        channel: result.channel.unwrap_or_default(),
        ts: result.ts.unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn slack_delete_file(
    _state: State<'_, AppState>,
    bot_token: String,
    file_id: String,
) -> CommandResult<()> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/files.delete", SLACK_API_BASE))
        .header("Authorization", format!("Bearer {}", bot_token))
        .form(&[("file", file_id)])
        .send()
        .await
        .map_err(|e| format_reqwest_error("Failed to delete Slack file", e))?;

    let result: SlackGenericResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!(
            "Failed to parse Slack file delete response: {}",
            e
        ))
    })?;

    if !result.ok {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to delete Slack file: {}",
            result.error.unwrap_or_else(|| "unknown_error".to_string())
        )));
    }

    Ok(())
}

#[tauri::command]
pub async fn slack_download_file(
    _state: State<'_, AppState>,
    bot_token: String,
    url: String,
) -> CommandResult<SlackDownloadResult> {
    if !url.starts_with("https://files.slack.com/") && !url.starts_with("https://slack-files.com/")
    {
        return Err(crate::error::AppError::Generic(format!(
            "Slack file download only supports Slack file URLs: {}",
            url
        )));
    }

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", bot_token))
        .send()
        .await
        .map_err(|e| format_reqwest_error("Slack file download request failed", e))?;

    if !response.status().is_success() {
        return Err(crate::error::AppError::Generic(format!(
            "Slack file download failed, HTTP status: {}",
            response.status().as_u16()
        )));
    }

    let mime_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response.bytes().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to read Slack downloaded file: {}", e))
    })?;

    Ok(SlackDownloadResult {
        base64: BASE64_ENGINE.encode(&bytes),
        mime_type,
    })
}

#[tauri::command]
pub async fn im_save_attachment(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    base64_content: String,
    file_name: String,
) -> CommandResult<String> {
    let bytes = BASE64_ENGINE.decode(&base64_content).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to decode attachment base64: {}", e))
    })?;

    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to get AppData directory: {}", e))
    })?;

    let attachments_dir = app_data_dir.join("im_attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to create attachment directory: {}", e))
    })?;

    let safe_name = file_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let file_path = attachments_dir.join(&safe_name);

    std::fs::write(&file_path, &bytes).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to save attachment file: {}", e))
    })?;

    file_path.to_str().map(str::to_string).ok_or_else(|| {
        crate::error::AppError::Generic("Attachment path contains non-UTF-8 characters".to_string())
    })
}

#[tauri::command]
pub async fn im_write_app_data_file(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    file_name: String,
    content: String,
) -> CommandResult<String> {
    validate_app_data_file_name(&file_name)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to get AppData directory: {}", e))
    })?;
    let file_path = app_data_dir.join(&file_name);

    std::fs::write(&file_path, content.as_bytes())
        .map_err(|e| crate::error::AppError::Generic(format!("Failed to write file: {}", e)))?;

    file_path.to_str().map(str::to_string).ok_or_else(|| {
        crate::error::AppError::Generic("File path contains non-UTF-8 characters".to_string())
    })
}

#[tauri::command]
pub async fn im_delete_app_data_file(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    file_name: String,
) -> CommandResult<()> {
    validate_app_data_file_name(&file_name)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to get AppData directory: {}", e))
    })?;
    let file_path = app_data_dir.join(&file_name);

    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| {
            crate::error::AppError::Generic(format!("Failed to delete file: {}", e))
        })?;
    }

    Ok(())
}

fn validate_app_data_file_name(file_name: &str) -> CommandResult<()> {
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(crate::error::AppError::Generic(
            "file_name must not contain path separators or ..".to_string(),
        ));
    }
    Ok(())
}
