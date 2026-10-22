//! 应用层命令：窗口 / 激活授权 / 设置 / 录制文件 / 功能清单。
//!
//! 激活授权的**格式与 Electron 版完全一致**（同一套激活码两边都能用）：
//!   `cs1.<base64url(payload)>.<base64url(ed25519 签名)>`
//!   payload = { v:1, product:"campus-network-connector", device:"<24位hex>" }
//!   device  = hex(sha256("campus-network-connector/offline-state/v2:" + machineHash))[0..24]
//!   machineHash = hex(sha256("darwin:<IOPlatformUUID>"))

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

pub const ACTIVATION_PUBLIC_KEY_B64: &str = "j5FyVLxHq1KZLNMrWYey+pfbq/wRSghcy7URZLmiYBU=";
pub const ACTIVATION_PRODUCT_ID: &str = "campus-network-connector";
pub const ACTIVATION_LICENSE_PREFIX: &str = "cs1";
pub const ACTIVATION_STATE_SALT: &str = "campus-network-connector/offline-state/v2";

// ── 路径 ─────────────────────────────────────────────

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取不到数据目录: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("建数据目录失败: {}", e))?;
    Ok(dir)
}

fn activation_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("activation-state.json"))
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("settings.json"))
}

fn install_id_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("install.id"))
}

fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("recordings");
    fs::create_dir_all(&dir).map_err(|e| format!("建录制目录失败: {}", e))?;
    Ok(dir)
}

// ── 工具 ─────────────────────────────────────────────

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut t = s.replace('-', "+").replace('_', "/");
    while t.len() % 4 != 0 {
        t.push('=');
    }
    // 标准 base64 解码（自实现，避免多一个依赖）
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        rev[*c as usize] = i as u8;
    }
    let bytes = t.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in bytes {
        if *b == b'=' {
            break;
        }
        let v = rev[*b as usize];
        if v == 255 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    if getrandom::getrandom(&mut buf).is_err() {
        // 兜底:系统随机源拿不到时用时间戳凑一凑(设备指纹而已,别全 0)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((now >> ((i % 8) * 8)) & 0xff) as u8;
        }
    }
    hex::encode(buf)
}

/// 机器指纹：macOS 的 IOPlatformUUID。
fn machine_fingerprint(app: &AppHandle) -> String {
    if let Ok(out) = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(idx) = text.find("\"IOPlatformUUID\"") {
            let rest = &text[idx..];
            if let Some(a) = rest.find('"') {
                let rest2 = &rest[a + 1..];
                if let Some(b) = rest2.find('"') {
                    let uuid = &rest2[..b];
                    if !uuid.is_empty() {
                        return format!("darwin:{}", uuid);
                    }
                }
            }
        }
    }
    format!("fallback:{}", get_install_id(app).unwrap_or_default())
}

fn get_install_id(app: &AppHandle) -> Result<String, String> {
    let fp = install_id_file(app)?;
    if let Ok(existing) = fs::read_to_string(&fp) {
        let t = existing.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    let id = format!(
        "{}-{}-4{}-{:x}-{}",
        &random_hex(4),
        &random_hex(2),
        &random_hex(3)[1..],
        (u16::from_be_bytes([random_hex(1).as_bytes()[0], random_hex(1).as_bytes()[1]]) & 0x3fff) | 0x8000,
        &random_hex(6)
    );
    let _ = fs::write(&fp, format!("{}\n", id));
    Ok(id)
}

fn machine_hash(app: &AppHandle) -> String {
    sha256_hex(machine_fingerprint(app).as_bytes())
}

/// 设备 UUID：与 Electron 版同算法。
fn device_uuid(app: &AppHandle) -> String {
    let mh = machine_hash(app);
    let signing = sha256_hex(format!("{}:{}", ACTIVATION_STATE_SALT, mh).as_bytes());
    normalize_uuid_for_license(&signing)
}

fn normalize_uuid_for_license(raw: &str) -> String {
    let hex_only: String = raw
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    if hex_only.len() >= 24 {
        return hex_only[..24].to_lowercase();
    }
    sha256_hex(raw.as_bytes())[..24].to_lowercase()
}

// ── 激活状态 ─────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ActivationState {
    pub install_id: String,
    pub device_uuid: String,
    pub machine_hash: String,
    pub trial_used: bool,
    pub trial_expires_at: i64,
    pub license: String,
}

fn read_activation_state(app: &AppHandle) -> ActivationState {
    let mut st = ActivationState::default();
    if let Ok(fp) = activation_state_file(app) {
        if let Ok(raw) = fs::read_to_string(&fp) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                st.install_id = v.get("installId").and_then(|x| x.as_str()).unwrap_or("").into();
                st.device_uuid = v.get("deviceUuid").and_then(|x| x.as_str()).unwrap_or("").into();
                st.machine_hash = v.get("machineHash").and_then(|x| x.as_str()).unwrap_or("").into();
                st.trial_used = v.get("trialUsed").and_then(|x| x.as_bool()).unwrap_or(false);
                st.trial_expires_at = v.get("trialExpiresAt").and_then(|x| x.as_i64()).unwrap_or(0);
                st.license = v.get("license").and_then(|x| x.as_str()).unwrap_or("").into();
            }
        }
    }
    st
}

fn write_activation_state(app: &AppHandle, st: &ActivationState) -> Result<(), String> {
    let fp = activation_state_file(app)?;
    let json = serde_json::json!({
        "installId": st.install_id,
        "deviceUuid": st.device_uuid,
        "machineHash": st.machine_hash,
        "trialUsed": st.trial_used,
        "trialExpiresAt": st.trial_expires_at,
        "license": st.license,
    });
    fs::write(&fp, serde_json::to_string_pretty(&json).unwrap_or_default())
        .map_err(|e| format!("写激活状态失败: {}", e))
}

/// 校验激活码：格式 / 签名 / 产品 / 设备。
pub fn verify_license(license: &str, device_uuid: &str) -> Result<(), String> {
    let parts: Vec<&str> = license.trim().split('.').collect();
    if parts.len() != 3 {
        return Err("激活码格式不正确".into());
    }
    if parts[0] != ACTIVATION_LICENSE_PREFIX {
        return Err(format!("激活码前缀不匹配（期望 {}）", ACTIVATION_LICENSE_PREFIX));
    }
    let payload_bytes = b64url_decode(parts[1]).ok_or("激活码内容无法解析")?;
    let sig_bytes = b64url_decode(parts[2]).ok_or("激活码内容无法解析")?;
    let pk_raw = b64url_decode(ACTIVATION_PUBLIC_KEY_B64).ok_or("内置公钥损坏")?;
    if pk_raw.len() != 32 {
        return Err("内置公钥损坏".into());
    }
    let mut pk_bytes = [0u8; 32];
    pk_bytes.copy_from_slice(&pk_raw);
    let sig: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "激活码内容无法解析".to_string())?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&pk_bytes)
        .map_err(|_| "内置公钥损坏".to_string())?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig);
    use ed25519_dalek::Verifier;
    key.verify(&payload_bytes, &signature)
        .map_err(|_| "激活码校验失败：签名不合法".to_string())?;

    let payload: serde_json::Value =
        serde_json::from_slice(&payload_bytes).map_err(|_| "激活码 payload 不是有效 JSON".to_string())?;
    if payload.get("v").and_then(|x| x.as_i64()).unwrap_or(0) != 1 {
        return Err("激活码版本不支持".into());
    }
    if payload.get("product").and_then(|x| x.as_str()).unwrap_or("") != ACTIVATION_PRODUCT_ID {
        return Err("激活码 product 不匹配".into());
    }
    if payload.get("device").and_then(|x| x.as_str()).unwrap_or("") != normalize_uuid_for_license(device_uuid) {
        return Err("激活码设备不匹配".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_activation_snapshot(app: AppHandle) -> Result<serde_json::Value, String> {
    let st = read_activation_state(&app);
    let now = now_ms();
    let device_uuid = device_uuid(&app);
    let mut status = "unactivated";
    let mut license_valid = false;

    if st.trial_expires_at > now {
        status = "trial";
    } else if !st.license.trim().is_empty() {
        match verify_license(&st.license, &device_uuid) {
            Ok(()) => {
                status = "licensed";
                license_valid = true;
            }
            Err(_) => status = "unactivated",
        }
    }

    Ok(serde_json::json!({
        "deviceUuid": device_uuid,
        "trialUsed": st.trial_used,
        "trialExpiresAt": st.trial_expires_at,
        "license": st.license,
        "licenseValid": license_valid,
        "status": status,
        "trialRemainingMs": (st.trial_expires_at - now).max(0),
    }))
}

#[tauri::command]
pub fn start_trial(app: AppHandle, expires_at: i64) -> Result<serde_json::Value, String> {
    let mut st = read_activation_state(&app);
    if st.trial_used {
        return Err("该设备已使用过试用".into());
    }
    st.trial_used = true;
    st.trial_expires_at = expires_at;
    st.install_id = get_install_id(&app)?;
    st.device_uuid = device_uuid(&app);
    st.machine_hash = machine_hash(&app);
    write_activation_state(&app, &st)?;
    Ok(serde_json::json!({ "status": "success" }))
}

#[tauri::command]
pub fn save_license(app: AppHandle, license: String) -> Result<serde_json::Value, String> {
    let du = device_uuid(&app);
    verify_license(&license, &du)?;
    let mut st = read_activation_state(&app);
    st.license = license;
    st.install_id = get_install_id(&app)?;
    st.device_uuid = du;
    st.machine_hash = machine_hash(&app);
    write_activation_state(&app, &st)?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn clear_license(app: AppHandle) -> Result<serde_json::Value, String> {
    let mut st = read_activation_state(&app);
    st.license = String::new();
    write_activation_state(&app, &st)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// 旧版扁平存储 → 新命名空间的一次性迁移。
#[tauri::command]
pub fn migrate_legacy_activation(
    app: AppHandle,
    legacy: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut st = read_activation_state(&app);
    let mut changed = false;
    if st.license.is_empty() {
        if let Some(l) = legacy.get("license").and_then(|x| x.as_str()) {
            if !l.trim().is_empty() {
                st.license = l.to_string();
                changed = true;
            }
        }
    }
    if !st.trial_used {
        if legacy.get("trialUsed").and_then(|x| x.as_bool()).unwrap_or(false) {
            st.trial_used = true;
            changed = true;
        }
    }
    if st.trial_expires_at == 0 {
        let e = legacy.get("trialExpiresAt").and_then(|x| x.as_i64()).unwrap_or(0);
        if e > 0 {
            st.trial_expires_at = e;
            changed = true;
        }
    }
    if changed {
        st.install_id = get_install_id(&app)?;
        st.device_uuid = device_uuid(&app);
        st.machine_hash = machine_hash(&app);
        write_activation_state(&app, &st)?;
    }
    Ok(serde_json::json!({ "ok": true, "changed": changed }))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── 设置 ─────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let fp = settings_file(&app)?;
    if let Ok(raw) = fs::read_to_string(&fp) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(v);
        }
    }
    Ok(serde_json::json!({}))
}

#[tauri::command]
pub fn set_settings(app: AppHandle, patch: serde_json::Value) -> Result<bool, String> {
    let fp = settings_file(&app)?;
    let mut current = serde_json::json!({});
    if let Ok(raw) = fs::read_to_string(&fp) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            current = v;
        }
    }
    if let Some(obj) = current.as_object_mut() {
        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    fs::write(&fp, serde_json::to_string_pretty(&current).unwrap_or_default())
        .map_err(|e| format!("写设置失败: {}", e))?;
    Ok(true)
}

// ── 录制文件 ─────────────────────────────────────────

#[tauri::command]
pub fn list_files(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = recordings_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let clicks = fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("clicks").cloned())
                .unwrap_or(serde_json::json!([]));
            out.push(serde_json::json!({ "id": name, "name": name, "clicks": clicks }));
        }
    }
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|x| x.as_str()).unwrap_or(""))
    });
    Ok(out)
}

#[tauri::command]
pub fn save_file(
    app: AppHandle,
    clicks: serde_json::Value,
    filename: String,
) -> Result<bool, String> {
    let dir = recordings_dir(&app)?;
    let name = if filename.ends_with(".json") {
        filename
    } else {
        format!("{}.json", filename)
    };
    let body = serde_json::json!({ "clicks": clicks, "savedAt": now_ms() });
    fs::write(
        dir.join(&name),
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    )
    .map_err(|e| format!("保存失败: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub fn rename_file(app: AppHandle, old_name: String, new_name: String) -> Result<bool, String> {
    let dir = recordings_dir(&app)?;
    let old = dir.join(&old_name);
    let mut new = new_name.clone();
    if !new.ends_with(".json") {
        new.push_str(".json");
    }
    fs::rename(&old, dir.join(&new)).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub fn delete_file(app: AppHandle, filename: String) -> Result<bool, String> {
    let dir = recordings_dir(&app)?;
    fs::remove_file(dir.join(&filename)).map_err(|e| format!("删除失败: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub fn read_file(app: AppHandle, filename: String) -> Result<serde_json::Value, String> {
    let dir = recordings_dir(&app)?;
    let raw = fs::read_to_string(dir.join(&filename)).map_err(|e| format!("读取失败: {}", e))?;
    Ok(serde_json::from_str(&raw).unwrap_or(serde_json::json!({})))
}

// ── 功能清单 ─────────────────────────────────────────

/// 功能清单：与 Electron 版 `src/features/index.js` 的 FEATURES 保持一致。
///
/// `safari-repair` 走 Apple Events，**只有 macOS 有** → Windows 上清单是空的。
/// （Windows 的浏览器字体纠正走 Chrome/Edge 扩展，独立于桌面应用，
///   所以桌面应用里不需要、也不该出现这个开关。ADR-0012）
#[tauri::command]
pub fn get_features() -> Vec<serde_json::Value> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    vec![serde_json::json!({
        "id": "safari-repair",
        "title": "Safari 复制修复",
        "description": "把被网页字体混淆的文字还原成你看到的那句话",
        "prefix": "safariRepair",
    })]
}

#[tauri::command]
pub fn get_feature_status(prefix: String) -> Result<serde_json::Value, String> {
    if prefix == "safariRepair" {
        return Ok(serde_json::json!({
            "enabled": crate::safari::repair::is_enabled(),
            "supported": cfg!(target_os = "macos"),
            "injected": crate::safari::repair::is_injected(),
            // 失败原因必须回传,界面才显示得出"为什么没反应"
            "lastError": crate::safari::repair::last_error(),
        }));
    }
    Ok(serde_json::json!({ "enabled": false, "supported": false, "lastError": "" }))
}

#[tauri::command]
pub fn set_feature_enabled(app: AppHandle, prefix: String, enabled: bool) -> Result<bool, String> {
    if prefix == "safariRepair" {
        crate::safari::repair::set_enabled(enabled);
        // 必须落盘:只改内存的话,重启 App 开关就没了 —— 用户会以为"功能坏了"。
        // (Electron 版一直落在 settings.json 的 features.<功能名>.enabled)
        let _ = set_feature_enabled_state(&app, "safari-repair", enabled);
    }
    Ok(true)
}

/// 读某个功能的开关状态(与 Electron 版的 settings.json 结构一致)。
pub fn feature_enabled(app: &AppHandle, feature_id: &str) -> bool {
    let Ok(fp) = settings_file(app) else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(&fp) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    v.get("features")
        .and_then(|f| f.get(feature_id))
        .and_then(|f| f.get("enabled"))
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
}

/// 把某个功能的开关状态落盘(与 Electron 版同一处 settings.json)。
pub fn set_feature_enabled_state(
    app: &AppHandle,
    feature_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let fp = settings_file(app)?;
    let mut current = serde_json::json!({});
    if let Ok(raw) = fs::read_to_string(&fp) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            current = v;
        }
    }
    if let Some(obj) = current.as_object_mut() {
        let features = obj
            .entry("features")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(f) = features.as_object_mut() {
            let ns = f
                .entry(feature_id)
                .or_insert_with(|| serde_json::json!({}));
            if let Some(n) = ns.as_object_mut() {
                n.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
            }
        }
    }
    fs::write(&fp, serde_json::to_string_pretty(&current).unwrap_or_default())
        .map_err(|e| format!("写设置失败: {}", e))
}

// ── 原生模块状态 ─────────────────────────────────────

#[tauri::command]
pub fn get_native_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "ok": cfg!(target_os = "macos"),
        "platform": std::env::consts::OS,
        // 发合成点击/按键需要 macOS 的「辅助功能」权限;
        // 没有的话事件会被系统静默丢弃(命令返回成功,但什么都没发生)。
        "accessibilityTrusted": super::native::accessibility_trusted(),
    }))
}

