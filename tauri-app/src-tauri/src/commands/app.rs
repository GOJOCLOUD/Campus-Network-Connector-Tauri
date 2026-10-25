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

pub fn sha256_hex(data: &[u8]) -> String {
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
        "installId": st.install_id,
        "machineHash": st.machine_hash,
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
        // **已经用过了就返回当前快照,不报错** —— 与 Electron 版同口径。
        // (之前这里 Err,界面上 `await cnc.startTrial(...)` 没有 catch,
        //  于是变成一次没人处理的 rejection:协议框关不掉、也没任何提示。)
        return get_activation_snapshot(app);
    }
    st.trial_used = true;
    st.trial_expires_at = expires_at;
    st.install_id = get_install_id(&app)?;
    st.device_uuid = device_uuid(&app);
    st.machine_hash = machine_hash(&app);
    write_activation_state(&app, &st)?;
    // 返回激活快照(Electron 版 updateActivationState 返回的也是快照)
    get_activation_snapshot(app)
}

#[tauri::command]
pub fn save_license(app: AppHandle, license: String) -> Result<serde_json::Value, String> {
    let du = device_uuid(&app);
    // **失败要带原因** —— 界面判的是 `r.ok`,失败时显示 `r.error`
    // (Electron 版返回 { ok:false, error })。之前这里直接 Err,
    //  界面只能显示笼统的"激活失败",用户不知道是码错了还是设备不匹配。
    if let Err(e) = verify_license(&license, &du) {
        return Ok(serde_json::json!({ "ok": false, "error": e }));
    }
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

pub fn now_ms() -> i64 {
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

/// 录制文件清单。
///
/// 形状与 Electron 版 `file:listFiles` 一致：`[{ id, name }]`
/// （id 是从 1 开始的序号，name 是文件名含 .json）。
/// 界面那边自己会再重映射一次 id，两边形状一致才不会各写各的。
#[tauri::command]
pub fn list_files(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = recordings_dir(&app)?;
    let mut names: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    Ok(names
        .iter()
        .enumerate()
        .map(|(i, name)| serde_json::json!({ "id": i + 1, "name": name }))
        .collect())
}

/// 下一个自动文件名：`点击N.json`（N = 已有最大值 + 1）。
/// 与 Electron 版 `getNextRecordingFileName()` 同口径。
fn next_recording_file_name(dir: &PathBuf) -> String {
    let mut max_n = 0i64;
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.path();
            let name = match name.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            // 认 `点击12.json` / `点击_12.json`
            let rest = match name.strip_prefix("点击") {
                Some(r) => r,
                None => continue,
            };
            let rest = rest.strip_prefix('_').unwrap_or(rest);
            let num = match rest.strip_suffix(".json") {
                Some(n) => n,
                None => continue,
            };
            if let Ok(v) = num.parse::<i64>() {
                if v > max_n {
                    max_n = v;
                }
            }
        }
    }
    format!("点击{}.json", max_n + 1)
}

/// ISO8601 UTC 时间戳，和 Electron 的 `new Date().toISOString()` 同一形状：
/// `2026-10-22T09:30:00.000Z`
fn iso8601_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 天数 → 年月日（Howard Hinnant 的 civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, h, mi, s, millis
    )
}

/// 保存录制文件。
///
/// **参数与返回形状都按 Electron 版 `file:saveFile` 对齐**：
/// - `filename` **可以不给**（界面上点"保存"就是只传 clicks）：
///   不给或不给 .json 后缀时自动取 `点击N.json`（Electron 同口径）。
/// - 返回 `{ status: 'success', file }`，失败 `{ status: 'error', message }`
///   —— 界面判的是 `data?.status === 'success'`，返回别的形状界面就永远显示"失败"。
#[tauri::command]
pub fn save_file(
    app: AppHandle,
    clicks: serde_json::Value,
    filename: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = recordings_dir(&app)?;
    let name = match filename {
        Some(n) if !n.trim().is_empty() && n.ends_with(".json") => n,
        _ => next_recording_file_name(&dir),
    };
    let count = clicks.as_array().map(|a| a.len()).unwrap_or(0);
    let body = serde_json::json!({
        "start_time": iso8601_utc(now_ms()),
        "click_count": count,
        "clicks": clicks,
    });
    match fs::write(
        dir.join(&name),
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    ) {
        Ok(_) => Ok(serde_json::json!({ "status": "success", "file": name })),
        Err(e) => Ok(serde_json::json!({ "status": "error", "message": format!("保存失败: {}", e) })),
    }
}

/// 重命名录制文件。返回 `{ status: 'success' }` / `{ status: 'error', message }`。
#[tauri::command]
pub fn rename_file(
    app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<serde_json::Value, String> {
    let dir = recordings_dir(&app)?;
    let mut new = new_name.clone();
    if !new.ends_with(".json") {
        new.push_str(".json");
    }
    match fs::rename(dir.join(&old_name), dir.join(&new)) {
        Ok(_) => Ok(serde_json::json!({ "status": "success" })),
        Err(e) => Ok(serde_json::json!({ "status": "error", "message": format!("重命名失败: {}", e) })),
    }
}

/// 删除录制文件。返回 `{ status: 'success' }` / `{ status: 'error', message }`。
#[tauri::command]
pub fn delete_file(app: AppHandle, filename: String) -> Result<serde_json::Value, String> {
    let dir = recordings_dir(&app)?;
    match fs::remove_file(dir.join(&filename)) {
        Ok(_) => Ok(serde_json::json!({ "status": "success" })),
        Err(e) => Ok(serde_json::json!({ "status": "error", "message": format!("删除失败: {}", e) })),
    }
}

/// 读录制文件。**读不到返回 null**（Electron 同口径），不是报错 —— 界面那边
/// 判的是"有没有内容"，不是"有没有失败"。
#[tauri::command]
pub fn read_file(app: AppHandle, filename: String) -> Result<Option<serde_json::Value>, String> {
    let dir = recordings_dir(&app)?;
    let raw = match fs::read_to_string(dir.join(&filename)) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    Ok(serde_json::from_str(&raw).ok())
}

// ── 功能清单 ─────────────────────────────────────────

/// 功能清单：与 Electron 版 `src/features/index.js` 的 FEATURES 保持一致。
///
/// - macOS：`safari-repair`（走 Apple Events 驱动 Safari）
/// - Windows：`chromium-repair`（把扩展注册进 Chrome / Edge）
///
/// 两条线的**开关长得一模一样**（同一个前端组件、同一个位置），
/// 差别只在背后接的是哪个浏览器 —— ADR-0013。
///
/// ⚠️ 2026-10-25 更正：以前 Windows 上这里是**空的**，理由是
/// 「桌面程序接管不了浏览器 ⇒ 给开关就是骗人」，于是界面上给的是一段说明书
/// （让用户自己去 chrome://extensions「加载已解压的扩展程序」）。
/// 用户原话：「Windows上我要和Mac一样的工作方式…你别搞什么这种搞扩展这么复杂的操作」。
/// ⇒ 现在 Windows 上**桌面程序能管**了：它把扩展注册进浏览器的外部扩展清单
/// （HKCU，不需要开发者模式）⇒ 开关是真的能用的。
#[tauri::command]
pub fn get_features() -> Vec<serde_json::Value> {
    if cfg!(target_os = "macos") {
        return vec![serde_json::json!({
            "id": "safari-repair",
            "title": "Safari 复制修复",
            "description": "把被网页字体混淆的文字还原成你看到的那句话",
            "prefix": "safariRepair",
        })];
    }
    if cfg!(target_os = "windows") {
        return vec![serde_json::json!({
            "id": "chromium-repair",
            "title": "浏览器复制修复",
            "description": "把被网页字体混淆的文字还原成你看到的那句话",
            "prefix": "chromiumRepair",
        })];
    }
    Vec::new()
}

/// Windows「浏览器复制修复」的状态。
///
/// 字段与 Electron 版 `chromiumRepair:getStatus` 对齐：
/// - `enabled`：开关（落盘的那份）
/// - `injected`：**已经注册进浏览器了没有**（注册表里有那两把键）
/// - `registered`：注册进了哪几个浏览器
/// - `browsersRunning`：浏览器现在开着没有 —— 开着就得重启才生效
/// - `hint`：一句话提示（"重启浏览器后生效"这种）
/// - `lastError`：失败原因
fn chromium_repair_status(app: &AppHandle) -> serde_json::Value {
    let enabled = feature_enabled(app, "chromium-repair");
    let id = crate::chromium::repair::extension_id().unwrap_or_default();
    let registered = if id.is_empty() {
        Vec::new()
    } else {
        crate::chromium::repair::registered_browsers(&id)
    };
    let running = crate::chromium::repair::browsers_running();
    let hint = if enabled && !registered.is_empty() {
        if running.is_empty() {
            format!("已注册到 {}，下次打开浏览器即生效。", registered.join("、"))
        } else {
            format!(
                "已注册到 {}，但浏览器正在运行 —— 请重启一次浏览器后生效。",
                registered.join("、")
            )
        }
    } else {
        String::new()
    };
    serde_json::json!({
        "enabled": enabled,
        "supported": cfg!(target_os = "windows"),
        "injected": !registered.is_empty(),
        "registered": registered,
        "browsersRunning": running,
        "hint": hint,
        "lastError": crate::chromium::repair::last_error(),
    })
}

/// 功能状态 —— 字段与 Electron 版 `features:getStatus` 对齐。
///
/// 界面要看三样:
/// - `safariRunning`:Safari 没开是**中性状态**(不是故障),要单独提示
/// - `injected`:已经接管了没有
/// - `lastError`:为什么没反应(不然用户只看到"已开启"却什么都没发生)
#[tauri::command]
pub fn get_feature_status(app: AppHandle, prefix: String) -> Result<serde_json::Value, String> {
    if prefix == "safariRepair" {
        // Safari 在不在运行。**问不到 ≠ 没在跑**(多半是缺自动化权限),
        // 按"在跑"处理,与 Electron 版同口径,免得界面一直误报"Safari 没开"。
        let safari_running = crate::safari::repair::safari_running_state().unwrap_or(true);
        return Ok(serde_json::json!({
            "enabled": crate::safari::repair::is_enabled(),
            "supported": cfg!(target_os = "macos"),
            "injected": crate::safari::repair::is_injected(),
            "running": crate::safari::repair::is_enabled(),
            "safariRunning": safari_running,
            "lastError": crate::safari::repair::last_error(),
        }));
    }
    if prefix == "chromiumRepair" {
        return Ok(chromium_repair_status(&app));
    }
    Ok(serde_json::json!({ "enabled": false, "supported": false, "lastError": "" }))
}

/// 改**运行态**(立刻生效,不落盘)—— 与 Electron 版 `setFeatureEnabled` 同语义。
/// 界面同时还会调 `setFeatureEnabledSetting` 落盘,两条合起来才是"开关生效且记住"。
#[tauri::command]
pub fn set_feature_enabled(
    app: AppHandle,
    prefix: String,
    enabled: bool,
) -> Result<bool, String> {
    if prefix == "safariRepair" {
        crate::safari::repair::set_enabled(enabled);
    }
    if prefix == "chromiumRepair" {
        set_chromium_repair_enabled(&app, enabled)?;
    }
    Ok(true)
}

/// Windows「浏览器复制修复」的开关：**真的去注册 / 注销**扩展。
///
/// 失败要**如实报出去**（并记进 `lastError`）——
/// 界面会把 lastError 显示出来，否则用户只看到"已开启"却什么都没发生。
fn set_chromium_repair_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let id = crate::chromium::repair::extension_id()
        .ok_or_else(|| "扩展 manifest 缺少 key 字段，扩展 ID 算不出来".to_string())?;
    let version = crate::chromium::repair::extension_version()
        .unwrap_or_else(|| "0.1.0".to_string());
    let dir = crate::chromium::repair::extension_dir(app);
    if enabled && dir.is_none() {
        let message = "安装包里找不到浏览器修复扩展（browser-extension 目录）".to_string();
        crate::chromium::repair::set_last_error(Some(message.clone()));
        return Err(message);
    }
    match crate::chromium::repair::set_browsers(
        enabled,
        dir.as_deref(),
        &id,
        &version,
    ) {
        Ok(()) => {
            crate::chromium::repair::set_last_error(None);
            Ok(())
        }
        Err(error) => {
            crate::chromium::repair::set_last_error(Some(error.clone()));
            Err(error)
        }
    }
}

/// 启动时把注册表那两把键**重写一遍**（自愈：程序挪了位置也能修回来）。
pub fn reapply_chromium_repair(app: &AppHandle) -> Result<(), String> {
    set_chromium_repair_enabled(app, true)
}

/// 改**落盘状态**(下次启动仍生效)—— 与 Electron 版 `setFeatureEnabledSetting` 同语义。
#[tauri::command]
pub fn set_feature_enabled_setting(
    app: AppHandle,
    prefix: String,
    enabled: bool,
) -> Result<bool, String> {
    if prefix == "safariRepair" {
        set_feature_enabled_state(&app, "safari-repair", enabled)?;
    }
    if prefix == "chromiumRepair" {
        set_feature_enabled_state(&app, "chromium-repair", enabled)?;
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

/// 原生输入模块在**哪些平台**是实装的。
///
/// - macOS:CoreGraphics(CGEventTap 录制 / 合成输入)
/// - Windows:Win32(SendInput 合成输入 / 剪贴板)
///
/// 别的平台只有占位实现 ⇒ 原生能力不可用。
pub const NATIVE_MODULE_SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "windows"));

#[tauri::command]
pub fn get_native_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        // ⚠️ 这个字段的口径必须与 Electron 版**完全一样**:
        // `ok` = **原生模块能不能用**,不是「是不是 macOS」。
        //
        // 这里以前写的是 `cfg!(target_os = "macos")` —— 在 Windows 上**恒为 false**,
        // 于是界面上那条红底白字「模拟输入相关功能不可用:原生模块加载失败,
        // 请重新安装最新版安装包」**必然出现**;而实际上 Windows 的原生模块
        // 加载得好好的,「模拟输入」是能用的(用户 2026-10-24 反馈:
        // 「本来就没有这个功能 干嘛红底白字提醒」)。
        //
        // Electron 版那边是 `ok: !!native` —— **同名不同义**,这才是根因。
        //
        // 这里的判据:命令能调到 ⇒ 原生模块编译进来了、注册成功了
        // (真加载失败的话这条命令压根不会被注册,前端 invoke 会抛错,
        //  拿到的不是 `ok:false` 而是异常)。
        // 所以按「这个平台有没有原生模块」给,和 Electron 同口径。
        "ok": NATIVE_MODULE_SUPPORTED,
        // 出问题时才有内容(Electron 版是 `nativeModuleError`,空串 = 没问题)。
        "error": if NATIVE_MODULE_SUPPORTED {
            String::new()
        } else {
            "当前平台没有原生输入模块".to_string()
        },
        "platform": std::env::consts::OS,
        // 发合成点击/按键需要 macOS 的「辅助功能」权限;
        // 没有的话事件会被系统静默丢弃(命令返回成功,但什么都没发生)。
        "accessibilityTrusted": super::native::accessibility_trusted(),
        // 全局快捷键:**抢到了没有**。
        //
        // ⌃D 是我们**要抢**的那个(抢到手,别的软件才收不到 Ctrl+D,
        // 那个软件就不会被"退出")。但系统不会让两个进程同时拥有同一个组合键
        // ⇒ 别的软件先注册的话我们就抢不到。
        //
        // 这一栏就是为了让「抢没抢到」变成**看得见的事实**:
        // 抢不到时界面上要显示出来,而不是让你以为「按了没反应」是系统的问题。
        "globalShortcutsEnabled": true,
        "shortcutPasteRegistered": crate::shortcut_paste_registered(),
        // 窗口贴合内容时**实际**改过几次原生窗口尺寸(诊断用)。
        // 改一次 = 一次 WebView 整页重排;这个数一多就是肉眼可见的卡顿。
        "fitResizes": crate::FIT_RESIZE_COUNT.load(std::sync::atomic::Ordering::Relaxed),
    }))
}

// ── Electron 版数据迁移 ────────────────────────────────────────────
//
// 两个版本的**数据目录天生不是同一个**:
//
//   Electron:`app.getPath('userData')` 用的是 package.json 里的 `name`
//            (那个仓库写的是 `xyw`)→ macOS 上是
//            `~/Library/Application Support/xyw/`,
//            录制文件在它下面的 `data/recordings/`
//   Tauri  :`app_data_dir()` 用的是 identifier
//            → `~/Library/Application Support/com.gojocloud.campus-network-connector.tauri/`,
//            录制文件直接在 `recordings/`(比 Electron 少一层 `data/`)
//
// ⇒ 老用户升级过来会"自己的录制文件全没了"。
//
// 这里按 **Electron 自己那套迁移口径**(main.js 的 `migrateLegacyDataFiles`)来:
// **拷过去、只补缺的、绝不覆盖、绝不删除** —— 两边各自留着自己那份。
//
// **激活状态不搬**:那边是设备绑定的(Electron 落盘随机 UUID + HMAC,
// Tauri 是机器指纹派生),搬过来只会把两边都弄坏 —— 跨版本通用激活码另议。

/// Electron 版的数据目录名(Electron 的 userData = package.json 的 `name`)。
const ELECTRON_USER_DATA_DIR_NAME: &str = "xyw";

/// 把 `src` 里的 json **补**到 `dst`:只补 `dst` 没有的,已有的一个字节都不动。
/// 返回补过去的文件数。
fn fill_missing_json(src: &std::path::Path, dst: &std::path::Path) -> usize {
    let mut copied = 0;
    let Ok(rd) = fs::read_dir(src) else {
        return 0;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let target = dst.join(name);
        if target.exists() {
            continue; // 已经有了 —— 绝不覆盖
        }
        if fs::copy(&path, &target).is_ok() {
            copied += 1;
        }
    }
    copied
}

/// 设置合并:把 `src` 里 **dst 没有的顶层字段** 补进 `dst`(已有的不动)。
///
/// 「当前选中的录制文件」也一并带过来 —— 但只在**那个文件确实在 `recordings` 里存在**
/// 时才带,免得指着一个不存在的文件。
fn merge_missing_settings(
    src: &std::path::Path,
    dst: &std::path::Path,
    recordings: &std::path::Path,
) -> bool {
    let Ok(raw) = fs::read_to_string(src) else {
        return false;
    };
    let Ok(serde_json::Value::Object(src_map)) = serde_json::from_str::<serde_json::Value>(&raw)
    else {
        return false;
    };
    let mut cur: serde_json::Value = match fs::read_to_string(dst)
        .ok()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
    {
        Some(v) if v.is_object() => v,
        _ => serde_json::json!({}),
    };
    let Some(cur_map) = cur.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    for (k, v) in src_map.iter() {
        if !cur_map.contains_key(k) {
            cur_map.insert(k.clone(), v.clone());
            changed = true;
        }
    }
    // 当前选中的录制文件:Tauri 侧一般是空串,Electron 侧可能正选着某个文件
    let our_selected = cur_map
        .get("selectedJson")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if our_selected.is_empty() {
        if let Some(theirs) = src_map.get("selectedJson").and_then(|v| v.as_str()) {
            if !theirs.is_empty() && recordings.join(theirs).is_file() {
                cur_map.insert("selectedJson".to_string(), theirs.into());
                changed = true;
            }
        }
    }
    if changed {
        let _ = fs::write(dst, serde_json::to_string_pretty(&cur).unwrap_or_default());
    }
    changed
}

/// 启动时跑一次:把 Electron 侧的数据补过来。
pub fn migrate_electron_data(app: &AppHandle) {
    let Ok(mine) = app.path().app_data_dir() else {
        return;
    };
    let Some(parent) = mine.parent() else {
        return;
    };
    let electron_root = parent.join(ELECTRON_USER_DATA_DIR_NAME);
    if !electron_root.is_dir() {
        return; // 没装过 Electron 版:没什么可搬的
    }
    let Ok(our_dir) = data_dir(app) else {
        return;
    };
    let Ok(dst_dir) = recordings_dir(app) else {
        return;
    };

    // 1) 录制文件:**每次启动都补一遍** —— 老版之后新录的,新版下次启动也能看到
    let src_dir = electron_root.join("data").join("recordings");
    if src_dir.is_dir() {
        fill_missing_json(&src_dir, &dst_dir);
    }

    // 2) 设置:**只做一次**(写标记)—— 不然会把用户在**新版**改过的设置又盖回去
    let marker = our_dir.join(".electron-settings-migrated");
    if !marker.exists() {
        let src_settings = electron_root.join("settings.json");
        if src_settings.is_file() {
            merge_missing_settings(&src_settings, &our_dir.join("settings.json"), &dst_dir);
        }
        let _ = fs::write(&marker, now_ms().to_string());
    }
}

#[cfg(test)]
mod migrate_tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cnc-migrate-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 只补缺的_已有的不覆盖() {
        let root = tmpdir("fill");
        let src = root.join("src");
        let dst = root.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.json"), r#"{"v":1}"#).unwrap();
        fs::write(src.join("b.json"), r#"{"v":2}"#).unwrap();
        fs::write(src.join("not-json.txt"), "x").unwrap();
        fs::write(dst.join("b.json"), r#"{"v":999}"#).unwrap();

        assert_eq!(fill_missing_json(&src, &dst), 1);
        assert!(dst.join("a.json").is_file(), "缺的应该被补上");
        assert_eq!(
            fs::read_to_string(dst.join("b.json")).unwrap(),
            r#"{"v":999}"#,
            "已有的不能被覆盖"
        );
        assert!(!dst.join("not-json.txt").exists(), "只搬 json");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 设置只补顶层缺的字段() {
        let root = tmpdir("settings");
        let rec = root.join("recordings");
        fs::create_dir_all(&rec).unwrap();
        fs::write(rec.join("点击1.json"), "{}").unwrap();
        let src = root.join("electron.json");
        let dst = root.join("tauri.json");
        fs::write(
            &src,
            r#"{"selectedJson":"点击1.json","pinyinSources":{"button":"x"},"autoSwitchIme":true}"#,
        )
        .unwrap();
        fs::write(&dst, r#"{"selectedJson":"","features":{"safari-repair":{"enabled":true}}}"#)
            .unwrap();

        assert!(merge_missing_settings(&src, &dst, &rec));
        let out: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&dst).unwrap()).unwrap();
        assert_eq!(out["selectedJson"], "点击1.json");
        assert_eq!(out["autoSwitchIme"], true);
        assert_eq!(out["pinyinSources"]["button"], "x");
        assert_eq!(out["features"]["safari-repair"]["enabled"], true);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 选中的文件不存在时不带过来() {
        let root = tmpdir("selected");
        let rec = root.join("recordings");
        fs::create_dir_all(&rec).unwrap();
        let src = root.join("electron.json");
        let dst = root.join("tauri.json");
        fs::write(&src, r#"{"selectedJson":"不存在.json"}"#).unwrap();
        fs::write(&dst, r#"{"selectedJson":""}"#).unwrap();

        merge_missing_settings(&src, &dst, &rec);
        let out: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&dst).unwrap()).unwrap();
        assert_eq!(out["selectedJson"], "");
        let _ = fs::remove_dir_all(&root);
    }
}


/// `get_native_status` 的 `ok` 字段口径:**原生模块能不能用**。
///
/// 这条是被一条真 bug 逼出来的:它以前写的是 `cfg!(target_os = "macos")`,
/// 在 Windows 上**恒为 false** ⇒ 界面上那条红底白字「原生模块加载失败」
/// **必然出现** —— 而 Windows 的原生模块其实加载得好好的,「模拟输入」是能用的。
/// Electron 版那边是 `ok: !!native`:两个字段**同名不同义**,这才是根因。
#[cfg(test)]
mod native_status_tests {
    use super::*;

    #[test]
    fn ok_表示原生模块能不能用而不是是不是macos() {
        let st = get_native_status().unwrap();
        assert_eq!(
            st["ok"], NATIVE_MODULE_SUPPORTED,
            "ok 必须等于「本平台有没有原生模块」,不能写死成「是不是 macOS」"
        );
        // macOS 与 Windows 都有原生模块 ⇒ 这两个平台上 ok 必须是 true。
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert_eq!(
            st["ok"], true,
            "macOS / Windows 上原生模块是有的,ok 不许是 false"
        );
    }

    #[test]
    fn 有问题时才带错误原因() {
        let st = get_native_status().unwrap();
        if st["ok"] == true {
            assert_eq!(st["error"], "", "没问题的时候不能带错误原因");
        } else {
            assert!(
                !st["error"].as_str().unwrap_or("").is_empty(),
                "失败时必须写明原因"
            );
        }
    }
}
