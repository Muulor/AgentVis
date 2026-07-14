//! 飞书 HTTP API 代理命令
//!
//! 将飞书 REST API 调用代理到 Rust 后端
//! 绕过 Tauri Webview 的 CORS 限制

use crate::error::CommandResult;
use crate::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64_ENGINE, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri::State;

/// 飞书 API 基础 URL
const FEISHU_API_BASE: &str = "https://open.feishu.cn/open-apis";

// ═══════════════════════════════════════════════════════════════
// 请求/响应类型
// ═══════════════════════════════════════════════════════════════

/// 获取 tenant_access_token 响应
#[derive(Debug, Deserialize)]
struct FeishuTokenResponse {
    code: i32,
    msg: String,
    tenant_access_token: Option<String>,
    expire: Option<u64>,
}

/// Token 结果（返回给前端）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResult {
    pub token: String,
    pub expire: u64,
}

/// 发送消息响应
#[derive(Debug, Deserialize)]
struct FeishuSendResponse {
    code: i32,
    msg: String,
    data: Option<FeishuSendData>,
}

#[derive(Debug, Deserialize)]
struct FeishuSendData {
    message_id: Option<String>,
}

/// 消息发送结果（返回给前端）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub message_id: String,
}

/// 通用 API 响应（用于 PATCH 等无 data 的操作）
#[derive(Debug, Deserialize)]
struct FeishuGenericResponse {
    code: i32,
    msg: String,
}

// ═══════════════════════════════════════════════════════════════
// Tauri 命令
// ═══════════════════════════════════════════════════════════════

/// 获取飞书 tenant_access_token
///
/// 使用 App ID + App Secret 获取企业应用的访问凭证
#[tauri::command]
pub async fn feishu_get_token(
    _state: State<'_, AppState>,
    app_id: String,
    app_secret: String,
) -> CommandResult<TokenResult> {
    let client = reqwest::Client::new();

    let url = format!("{}/auth/v3/tenant_access_token/internal", FEISHU_API_BASE);

    let body = serde_json::json!({
        "app_id": app_id,
        "app_secret": app_secret,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            crate::error::AppError::Generic(format!("Feishu API request failed: {}", e))
        })?;

    let result: FeishuTokenResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Feishu API response: {}", e))
    })?;

    if result.code != 0 || result.tenant_access_token.is_none() {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to get tenant_access_token [code={}]: {}",
            result.code, result.msg
        )));
    }

    Ok(TokenResult {
        token: result.tenant_access_token.unwrap_or_default(),
        expire: result.expire.unwrap_or(7200),
    })
}

/// 发送飞书消息（文本或卡片）
///
/// @param token - tenant_access_token
/// @param chat_id - 目标接收者 ID（保留旧参数名以兼容前端现有调用）
/// @param receive_id_type - 接收者 ID 类型，默认 chat_id
/// @param msg_type - 消息类型（text / interactive）
/// @param content - 消息内容 JSON 字符串
#[tauri::command]
pub async fn feishu_send_message(
    _state: State<'_, AppState>,
    token: String,
    chat_id: String,
    msg_type: String,
    content: String,
    receive_id_type: Option<String>,
) -> CommandResult<SendResult> {
    let client = reqwest::Client::new();

    let receive_id_type = receive_id_type.unwrap_or_else(|| "chat_id".to_string());
    let allowed_receive_id_type = matches!(
        receive_id_type.as_str(),
        "chat_id" | "open_id" | "user_id" | "union_id" | "email"
    );
    if !allowed_receive_id_type {
        return Err(crate::error::AppError::Generic(format!(
            "Unsupported Feishu receive_id_type: {}",
            receive_id_type
        )));
    }

    let url = format!(
        "{}/im/v1/messages?receive_id_type={}",
        FEISHU_API_BASE, receive_id_type
    );

    let body = serde_json::json!({
        "receive_id": chat_id,
        "msg_type": msg_type,
        "content": content,
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            crate::error::AppError::Generic(format!("Failed to send Feishu message: {}", e))
        })?;

    let result: FeishuSendResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Feishu send response: {}", e))
    })?;

    if result.code != 0 {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to send Feishu message [code={}]: {}",
            result.code, result.msg
        )));
    }

    let message_id = result.data.and_then(|d| d.message_id).unwrap_or_default();

    Ok(SendResult { message_id })
}

/// 更新飞书消息卡片（PATCH）
///
/// 飞书 PATCH /im/v1/messages/{id} 更新消息内容时，必须同时携带 msg_type 字段，
/// 否则飞书服务端无法正确解析 content 的格式，导致手机端卡片显示为空白。
///
/// @param token - tenant_access_token
/// @param message_id - 消息 ID
/// @param content - 新的卡片内容 JSON 字符串（interactive card JSON）
#[tauri::command]
pub async fn feishu_update_message(
    _state: State<'_, AppState>,
    token: String,
    message_id: String,
    content: String,
) -> CommandResult<()> {
    let client = reqwest::Client::new();

    let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);

    // 注意：飞书更新消息 API 必须携带 msg_type，否则服务端不知道 content 的序列化格式，
    // 会导致手机端（对格式校验更严格）无法渲染卡片内容，显示为空白气泡。
    let body = serde_json::json!({
        "msg_type": "interactive",
        "content": content,
    });

    let response = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json; charset=utf-8")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            crate::error::AppError::Generic(format!("Failed to update Feishu card: {}", e))
        })?;

    let result: FeishuGenericResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Feishu update response: {}", e))
    })?;

    if result.code != 0 {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to update Feishu card [code={}]: {}",
            result.code, result.msg
        )));
    }

    Ok(())
}

/// Delete/retract a Feishu message sent by the bot.
#[tauri::command]
pub async fn feishu_delete_message(
    _state: State<'_, AppState>,
    token: String,
    message_id: String,
) -> CommandResult<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/im/v1/messages/{}", FEISHU_API_BASE, message_id);

    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| {
            crate::error::AppError::Generic(format!("Failed to delete Feishu message: {}", e))
        })?;

    let result: FeishuGenericResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to parse Feishu delete response: {}", e))
    })?;

    if result.code != 0 {
        return Err(crate::error::AppError::Generic(format!(
            "Failed to delete Feishu message [code={}]: {}",
            result.code, result.msg
        )));
    }

    Ok(())
}

/// HTTP 代理请求参数
#[derive(Debug, Deserialize)]
pub struct FeishuProxyRequest {
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
}

/// 通用飞书 HTTP POST 代理
///
/// 将任意 POST 请求转发到 open.feishu.cn 域名下的路径
/// 供飞书 SDK 内部 axios 调用使用（SDK 的 WebSocket 端点协商请求会被 CORS 阻拦）
///
/// 安全限制：仅允许 open.feishu.cn 域名
#[allow(dependency_on_unit_never_type_fallback)]
#[tauri::command]
pub async fn feishu_http_proxy(
    _state: State<'_, AppState>,
    request: FeishuProxyRequest,
) -> CommandResult<FeishuProxyResponse> {
    // 安全检查：只允许飞书域名
    if !request.url.starts_with("https://open.feishu.cn/") {
        return Err(crate::error::AppError::Generic(format!(
            "Feishu proxy only supports the open.feishu.cn domain: {}",
            request.url
        )));
    }

    let client = reqwest::Client::new();

    let mut req_builder = client.post(&request.url);

    // 转发所有请求头
    for (key, value) in &request.headers {
        // 跳过浏览器不允许设置的头部
        let lower_key = key.to_lowercase();
        if lower_key == "host" || lower_key == "content-length" {
            continue;
        }
        req_builder = req_builder.header(key.as_str(), value.as_str());
    }

    let response = req_builder.body(request.body).send().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Feishu proxy request failed: {}", e))
    })?;

    let status = response.status().as_u16();
    let response_headers: std::collections::HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
        .collect();

    let response_body = response.text().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to read Feishu proxy response: {}", e))
    })?;

    Ok(FeishuProxyResponse {
        status,
        headers: response_headers,
        body: response_body,
    })
}

/// HTTP 代理响应
#[derive(Debug, Serialize)]
pub struct FeishuProxyResponse {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
}

// ═══════════════════════════════════════════════════════════════
// 文件/图片上传下载相关类型
// ═══════════════════════════════════════════════════════════════

/// 飞书图片上传响应
#[derive(Debug, Deserialize)]
struct FeishuImageUploadResponse {
    code: i32,
    msg: String,
    data: Option<FeishuImageUploadData>,
}

#[derive(Debug, Deserialize)]
struct FeishuImageUploadData {
    image_key: Option<String>,
}

/// 图片上传结果（返回给前端）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUploadResult {
    pub image_key: String,
}

/// 飞书文件上传响应
#[derive(Debug, Deserialize)]
struct FeishuFileUploadResponse {
    code: i32,
    msg: String,
    data: Option<FeishuFileUploadData>,
}

#[derive(Debug, Deserialize)]
struct FeishuFileUploadData {
    file_key: Option<String>,
}

/// 文件上传结果（返回给前端）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUploadResult {
    pub file_key: String,
}

/// 资源下载结果（返回给前端）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDownloadResult {
    /// 文件内容的 base64 编码
    pub base64: String,
    /// MIME 类型
    pub mime_type: String,
}

// ═══════════════════════════════════════════════════════════════
// 文件/图片上传命令
// ═══════════════════════════════════════════════════════════════

/// 上传图片到飞书，返回 image_key
///
/// 飞书要求图片以 multipart/form-data 上传：
/// - image_type 固定为 message（用于消息发送）
/// - image 字段为图片二进制数据
/// - 大小限制：10 MB
///
/// @param token - tenant_access_token
/// @param image_base64 - 图片的 base64 编码内容
/// @param image_type_hint - 图片扩展名提示（如 "jpg", "png", "webp"）
#[tauri::command]
pub async fn feishu_upload_image(
    _state: State<'_, AppState>,
    token: String,
    image_base64: String,
    image_type_hint: String,
) -> CommandResult<ImageUploadResult> {
    use reqwest::multipart;

    // 将 base64 解码为二进制
    let image_bytes = BASE64_ENGINE.decode(&image_base64).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to decode image base64: {}", e))
    })?;

    let file_name = format!("image.{}", image_type_hint);
    // 根据扩展名推断 MIME 类型
    let mime_type = infer_image_mime(&image_type_hint);

    let url = format!("{}/im/v1/images", FEISHU_API_BASE);
    let client = reqwest::Client::new();

    // 构建 multipart form
    let image_part = multipart::Part::bytes(image_bytes)
        .file_name(file_name)
        .mime_str(&mime_type)
        .map_err(|e| crate::error::AppError::Generic(format!("Failed to set image MIME: {}", e)))?;

    let form = multipart::Form::new()
        .text("image_type", "message")
        .part("image", image_part);

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            crate::error::AppError::Generic(format!("Feishu image upload request failed: {}", e))
        })?;

    let result: FeishuImageUploadResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!(
            "Failed to parse Feishu image upload response: {}",
            e
        ))
    })?;

    if result.code != 0 {
        return Err(crate::error::AppError::Generic(format!(
            "Feishu image upload failed [code={}]: {}",
            result.code, result.msg
        )));
    }

    let image_key = result.data.and_then(|d| d.image_key).ok_or_else(|| {
        crate::error::AppError::Generic(
            "Feishu image upload response is missing image_key".to_string(),
        )
    })?;

    Ok(ImageUploadResult { image_key })
}

/// 上传文件到飞书，返回 file_key
///
/// 飞书要求文件以 multipart/form-data 上传：
/// - file_type 为飞书支持的文件类型标识
/// - file_name 为文件名
/// - file 字段为文件二进制数据
/// - 大小限制：30 MB（更大文件需要分片上传，暂不支持）
///
/// @param token - tenant_access_token
/// @param file_base64 - 文件的 base64 编码内容
/// @param file_name - 文件原始文件名（含扩展名）
/// @param file_type - 飞书文件类型标识（opendoc/pdf/stream 等）
#[tauri::command]
pub async fn feishu_upload_file(
    _state: State<'_, AppState>,
    token: String,
    file_base64: String,
    file_name: String,
    file_type: String,
) -> CommandResult<FileUploadResult> {
    use reqwest::multipart;

    // 将 base64 解码为二进制
    let file_bytes = BASE64_ENGINE.decode(&file_base64).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to decode file base64: {}", e))
    })?;

    let url = format!("{}/im/v1/files", FEISHU_API_BASE);
    let client = reqwest::Client::new();

    // 根据文件类型推断 MIME
    let mime_type = infer_file_mime(&file_name);

    // 构建 multipart form
    let file_part = multipart::Part::bytes(file_bytes)
        .file_name(file_name.clone())
        .mime_str(&mime_type)
        .map_err(|e| crate::error::AppError::Generic(format!("Failed to set file MIME: {}", e)))?;

    let form = multipart::Form::new()
        .text("file_type", file_type)
        .text("file_name", file_name)
        .part("file", file_part);

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            crate::error::AppError::Generic(format!("Feishu file upload request failed: {}", e))
        })?;

    let result: FeishuFileUploadResponse = response.json().await.map_err(|e| {
        crate::error::AppError::Generic(format!(
            "Failed to parse Feishu file upload response: {}",
            e
        ))
    })?;

    if result.code != 0 {
        return Err(crate::error::AppError::Generic(format!(
            "Feishu file upload failed [code={}]: {}",
            result.code, result.msg
        )));
    }

    let file_key = result.data.and_then(|d| d.file_key).ok_or_else(|| {
        crate::error::AppError::Generic(
            "Feishu file upload response is missing file_key".to_string(),
        )
    })?;

    Ok(FileUploadResult { file_key })
}

/// 下载飞书消息中的资源（图片/文件），返回 base64 编码内容
///
/// 用于处理用户通过飞书发送的文件/图片：
/// 接收到带附件的消息后，调用此命令将资源下载并保存到本地。
///
/// @param token - tenant_access_token
/// @param message_id - 包含资源的消息 ID
/// @param file_key - 资源的 key（image_key 或 file_key）
/// @param resource_type - 资源类型（"image" 或 "file"）
#[tauri::command]
pub async fn feishu_download_resource(
    _state: State<'_, AppState>,
    token: String,
    message_id: String,
    file_key: String,
    resource_type: String,
) -> CommandResult<ResourceDownloadResult> {
    use base64::Engine;

    let url = format!(
        "{}/im/v1/messages/{}/resources/{}?type={}",
        FEISHU_API_BASE, message_id, file_key, resource_type
    );

    let client = reqwest::Client::new();

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| {
            crate::error::AppError::Generic(format!(
                "Feishu resource download request failed: {}",
                e
            ))
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(crate::error::AppError::Generic(format!(
            "Feishu resource download failed, HTTP status: {}",
            status
        )));
    }

    // 从响应头中提取 MIME 类型
    let mime_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let bytes = response.bytes().await.map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to read Feishu downloaded resource: {}", e))
    })?;

    let base64_content = BASE64_ENGINE.encode(&bytes);

    Ok(ResourceDownloadResult {
        base64: base64_content,
        mime_type,
    })
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/// 根据图片扩展名推断 MIME 类型
fn infer_image_mime(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "png" => "image/png".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        "bmp" => "image/bmp".to_string(),
        _ => "image/jpeg".to_string(),
    }
}

/// 根据文件名推断 MIME 类型
fn infer_file_mime(file_name: &str) -> String {
    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf".to_string(),
        "docx" => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string()
        }
        "doc" => "application/msword".to_string(),
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
        "xls" => "application/vnd.ms-excel".to_string(),
        "pptx" => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_string()
        }
        "ppt" => "application/vnd.ms-powerpoint".to_string(),
        "txt" => "text/plain".to_string(),
        "md" => "text/markdown".to_string(),
        "zip" => "application/zip".to_string(),
        "mp4" => "video/mp4".to_string(),
        "mp3" => "audio/mpeg".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

/// 将飞书附件 base64 内容保存到本地 im_attachments 目录
///
/// 附件存储位置：{AppData}/im_attachments/{file_name}
/// 目录在首次调用时自动创建。
/// 返回保存后的绝对文件路径（供 Agent 使用 read 工具读取）。
///
/// @param app - Tauri App 句柄（用于获取 AppData 路径）
/// @param base64_content - 文件内容的 base64 编码
/// @param file_name - 保存的文件名
#[tauri::command]
pub async fn feishu_save_attachment(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    base64_content: String,
    file_name: String,
) -> CommandResult<String> {
    // 解码 base64
    let bytes = BASE64_ENGINE.decode(&base64_content).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to decode attachment base64: {}", e))
    })?;

    // 获取 AppData 目录，创建 im_attachments 子目录
    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to get AppData directory: {}", e))
    })?;

    let attachments_dir = app_data_dir.join("im_attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to create attachment directory: {}", e))
    })?;

    // 净化文件名，防止路径穿越
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

    let abs_path = file_path
        .to_str()
        .ok_or_else(|| {
            crate::error::AppError::Generic(
                "Attachment path contains non-UTF-8 characters".to_string(),
            )
        })?
        .to_string();

    Ok(abs_path)
}

/// 向 AppData 根目录写入文本文件（json/txt 等）
///
/// 专为 ImTaskBridge 写入 im_active_task.json 设计，
/// 使前端无需知道具体 AppData 绝对路径。
///
/// @param app - Tauri App 句柄
/// @param file_name - 文件名（仅文件名，不含路径，如 "im_active_task.json"）
/// @param content - 文本内容
#[tauri::command]
pub async fn feishu_write_app_data_file(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    file_name: String,
    content: String,
) -> CommandResult<String> {
    // 安全校验：file_name 不允许包含路径分隔符，防止路径穿越
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(crate::error::AppError::Generic(
            "file_name must not contain path separators or ..".to_string(),
        ));
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to get AppData directory: {}", e))
    })?;

    let file_path = app_data_dir.join(&file_name);

    std::fs::write(&file_path, content.as_bytes())
        .map_err(|e| crate::error::AppError::Generic(format!("Failed to write file: {}", e)))?;

    let abs_path = file_path
        .to_str()
        .ok_or_else(|| {
            crate::error::AppError::Generic("File path contains non-UTF-8 characters".to_string())
        })?
        .to_string();

    Ok(abs_path)
}

/// 删除 AppData 根目录下的文本文件
///
/// 专为 ImTaskBridge 清理 im_active_task_{botId}.json 设计：
/// 任务结束（完成/失败/取消）时调用，避免历史任务文件在 AppData 根目录持续累积。
/// 若文件不存在则静默成功（幂等操作，防止重复清理报错）。
///
/// @param app      - Tauri App 句柄（用于解析 AppData 路径）
/// @param file_name - 文件名（仅文件名，不含路径，如 "im_active_task_{botId}.json"）
#[tauri::command]
pub async fn feishu_delete_app_data_file(
    app: tauri::AppHandle,
    _state: State<'_, AppState>,
    file_name: String,
) -> CommandResult<()> {
    // 安全校验：file_name 不允许包含路径分隔符或 ..，防止路径穿越攻击
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(crate::error::AppError::Generic(
            "file_name must not contain path separators or ..".to_string(),
        ));
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        crate::error::AppError::Generic(format!("Failed to get AppData directory: {}", e))
    })?;

    let file_path = app_data_dir.join(&file_name);

    // 文件不存在视为成功（幂等：避免重复清理时出错）
    if !file_path.exists() {
        return Ok(());
    }

    std::fs::remove_file(&file_path)
        .map_err(|e| crate::error::AppError::Generic(format!("Failed to delete file: {}", e)))?;

    Ok(())
}
