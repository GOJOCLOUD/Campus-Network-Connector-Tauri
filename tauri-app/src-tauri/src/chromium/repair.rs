//! Windows 的「浏览器复制修复」—— 把 Chromium 扩展注册进 Chrome / Edge。
//!
//! ## 为什么是注册表
//!
//! Chrome / Edge 在**启动时**读一份「外部扩展清单」。Windows 上这份清单可以来自
//! 注册表的 `HKCU\Software\Google\Chrome\Extensions\<id>`（Edge 是
//! `HKCU\Software\Microsoft\Edge\Extensions\<id>`），里面写两值：
//!
//! ```text
//! path     = 扩展目录的绝对路径
//! version  = 与 manifest 里一致的版本号
//! ```
//!
//! 写进去之后，扩展以「外部安装」的身份出现：
//!   - **不需要开发者模式**
//!   - 用户**不用**去 chrome://extensions 里「加载已解压的扩展程序」
//!   - 用户**不用**自己选文件夹
//!
//! 这就是「和 Mac 一样的工作方式」在 Windows 上能做到的最简形态：
//! mac 上是「Safari 复制修复」那个开关，Windows 上也是**一个开关**。
//!
//! ## 扩展 ID 为什么是固定的
//!
//! manifest 里带一个 `key` 字段（公钥 DER 的 base64）⇒ 扩展 ID 由**公钥**决定
//! （SHA-256 前 128 位 → 32 个 a..p 的字母），**与装在哪台机器、哪个目录无关**。
//! 于是注册表键名是常量，安装目录变了只要重写一次 `path` 就行。
//!
//! ID 的算法见 `id_from_public_key`，有单元测试盯着；
//! manifest 里的 `key` 与这里算出来的 ID 是否一致，由
//! `tools/verify/verify-chromium-extension.cjs` 交叉校验。
//!
//! ## 边界
//!
//! - 写的是 **HKCU**（当前用户），不需要管理员权限。
//! - 浏览器**只在启动时**读这份清单 ⇒ 改完要**重启一次浏览器**才生效。
//!   这是浏览器的机制，不是本模块能绕过的；界面上必须把这句话说出来。
//! - 本模块只管「注册 / 注销」，不碰浏览器的任何数据。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 扩展的 manifest —— **编译期内嵌**，所以 ID 的来源永远与仓库里那份一致。
const EXTENSION_MANIFEST: &str =
    include_str!("../../../../apps/chromium-extension/manifest.json");

/// Chrome / Edge 读外部扩展清单的位置（HKCU 下的相对路径）。
const CHROME_KEY_PATH: &str = r"Software\Google\Chrome\Extensions";
const EDGE_KEY_PATH: &str = r"Software\Microsoft\Edge\Extensions";

/// 扩展目录在安装包里的**候选位置**。
///
/// 打包布局在不同 Tauri 版本 / 不同配置下可能是「保留相对路径」也可能是
/// 「映射到目标名」⇒ 两都试，找不到再说「安装包里没有扩展」，
/// 而不是让用户看到一个「已开启但没反应」的开关。
const EXTENSION_SUBDIRS: &[&str] = &[
    "browser-extension",
    "dist-core/chromium",
    "resources/browser-extension",
    "resources/dist-core/chromium",
];

/// 扩展 ID：SHA-256(公钥 DER) 的前 128 位 → 32 个十六进制位 → 每位映射到 a..p。
///
/// （Chrome 的规则：0→a、1→b、…、f→p。）
pub fn id_from_public_key(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    let mut out = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        out.push((b'a' + (byte >> 4)) as char);
        out.push((b'a' + (byte & 0x0f)) as char);
    }
    out
}

fn manifest_value(key: &str) -> Option<String> {
    let manifest: Value = serde_json::from_str(EXTENSION_MANIFEST).ok()?;
    manifest.get(key)?.as_str().map(|s| s.to_string())
}

/// 扩展 ID（由 manifest 里的 `key` 算出）。
pub fn extension_id() -> Option<String> {
    let key = manifest_value("key")?;
    let der = base64::engine::general_purpose::STANDARD.decode(key.trim()).ok()?;
    Some(id_from_public_key(&der))
}

/// 扩展版本号（注册表的 `version` 值必须与 manifest 一致）。
pub fn extension_version() -> Option<String> {
    manifest_value("version")
}

/// 扩展目录：装在应用包里那份。
///
/// 找不到就返回 `None` —— 调用方要把「安装包里没有扩展」如实报给界面，
/// 不能假装成功。
pub fn extension_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        for sub in EXTENSION_SUBDIRS {
            candidates.push(dir.join(sub));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for sub in EXTENSION_SUBDIRS {
                candidates.push(parent.join(sub));
            }
        }
    }
    // 开发时（未打包）：仓库里的构建产物
    candidates.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../dist-core/chromium"
    )));

    candidates
        .into_iter()
        .find(|dir| dir.join("manifest.json").is_file())
}

/// 跑一条 `reg.exe` 命令。返回是否成功。
///
/// 用 `reg.exe` 而不是注册表 crate：它每个 Windows 都有，
/// 不用给打包引入新依赖；而且**退出码与界面语言无关**
/// （`reg query` 的输出是本地化的，不能靠解析文本）。
fn reg(args: &[&str]) -> Result<bool, String> {
    let output = Command::new("reg.exe")
        .args(args)
        .output()
        .map_err(|e| format!("调用 reg.exe 失败: {}", e))?;
    Ok(output.status.success())
}

fn registry_key(browser: &str, id: &str) -> String {
    let base = if browser == "edge" {
        EDGE_KEY_PATH
    } else {
        CHROME_KEY_PATH
    };
    format!(r"HKCU\{}\{}", base, id)
}

/// 支持的浏览器（写注册表时的目标）。
pub const BROWSERS: &[(&str, &str)] = &[("chrome", "Chrome"), ("edge", "Edge")];

/// 把扩展注册进指定浏览器。
pub fn register_browser(browser: &str, id: &str, dir: &Path, version: &str) -> Result<(), String> {
    let key = registry_key(browser, id);
    let dir_text = dir.to_string_lossy().to_string();
    let path_args = [
        "add".to_string(),
        key.clone(),
        "/v".to_string(),
        "path".to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        dir_text,
        "/f".to_string(),
    ];
    let version_args = [
        "add".to_string(),
        key,
        "/v".to_string(),
        "version".to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        version.to_string(),
        "/f".to_string(),
    ];
    let path_refs: Vec<&str> = path_args.iter().map(|s| s.as_str()).collect();
    let version_refs: Vec<&str> = version_args.iter().map(|s| s.as_str()).collect();
    if !reg(&path_refs)? {
        return Err("写注册表 path 失败（reg.exe 返回失败）".to_string());
    }
    if !reg(&version_refs)? {
        return Err("写注册表 version 失败（reg.exe 返回失败）".to_string());
    }
    Ok(())
}

/// 从指定浏览器注销扩展。键本来就不在 ⇒ 也算成功（幂等）。
pub fn unregister_browser(browser: &str, id: &str) -> Result<(), String> {
    let key = registry_key(browser, id);
    let args = ["delete".to_string(), key, "/f".to_string()];
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    reg(&refs).map(|_| ())
}

/// 指定浏览器里是不是已经注册了。
pub fn is_registered_browser(browser: &str, id: &str) -> bool {
    let key = registry_key(browser, id);
    let args = ["query".to_string(), key, "/v".to_string(), "path".to_string()];
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    reg(&refs).unwrap_or(false)
}

/// 注册（或注销）全部浏览器。
pub fn set_browsers(enabled: bool, dir: Option<&Path>, id: &str, version: &str) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    for (browser, label) in BROWSERS {
        let result = if enabled {
            match dir {
                Some(dir) => register_browser(browser, id, dir, version),
                None => Err("找不到扩展目录".to_string()),
            }
        } else {
            unregister_browser(browser, id)
        };
        if let Err(error) = result {
            errors.push(format!("{}: {}", label, error));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

/// 已经注册了扩展的浏览器名。
pub fn registered_browsers(id: &str) -> Vec<String> {
    BROWSERS
        .iter()
        .filter(|(browser, _)| is_registered_browser(browser, id))
        .map(|(_, label)| (*label).to_string())
        .collect()
}

/// 上一次失败的因 —— 界面必须把它露出来，
/// 否则用户只看到「已开启」却什么都没发生，根本无从判断是权限还是别的问题。
static LAST_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn last_error_cell() -> &'static Mutex<Option<String>> {
    LAST_ERROR.get_or_init(|| Mutex::new(None))
}

/// 记一次失败原因（`None` = 清空）。
pub fn set_last_error(message: Option<String>) {
    if let Ok(mut cell) = last_error_cell().lock() {
        *cell = message;
    }
}

/// 上一次失败的原因（空串 = 没有失败）。
pub fn last_error() -> String {
    last_error_cell()
        .lock()
        .ok()
        .and_then(|cell| cell.clone())
        .unwrap_or_default()
}

/// Chrome / Edge 现在是不是开着。
///
/// 只看进程名（`chrome.exe` / `msedge.exe`）—— `tasklist` 的**表头是本地化的**，
/// 但镜像名不是，所以只按名字匹配是稳的。
pub fn browsers_running() -> Vec<String> {
    let output = Command::new("tasklist.exe").output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let mut running = Vec::new();
    for (process, label) in [("chrome.exe", "Chrome"), ("msedge.exe", "Edge")] {
        if text.contains(process) {
            running.push(label.to_string());
        }
    }
    running
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 扩展 manifest 里的 `key`（公钥 DER 的 base64）。
    ///
    /// 这把公钥是**专门为这个扩展生成的**：manifest 里放 `key` 之后，
    /// 扩展 ID 就由公钥决定 ⇒ 装在哪台机器、哪个目录都一样。
    /// 私钥没有用途、也没有保存 —— 未打包扩展不需要签名。
    const PUBLIC_KEY_BASE64: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsOYcLLERtl0pDblJ47Uunky0CnDvpxHyeDua2N0xYLbSySmD/vpUUtWPBDpG1HCkd9qOB7bIY5ljBJKbB4E4iWWSuSpQezizwXk3fVlpUxr/MbJe+eiFVGCB3yXNZV7he3otyljTAIcDhiz5ArJaOb8yapq4Bj2VjHqg2CiXoNncCTEmtrCFydB+ftozpvWRYAXpYKz78aijJfiqp0fxaMWOH0ee9FM25Q83aVHqs9ISBK8JYj+1fszZce2z6XCx/RxCv4mah+TRtajJPnFQD0UHnk5GC3mBFqH0UR3XH9G/+jju9AOr49tYUS6tlltyVH5+D8pc1DoccGis40vDAQIDAQAB";

    /// 上面那把公钥对应的扩展 ID。
    ///
    /// 这值用**三条互相独立的管道**算过（openssl 一条管道 / node crypto /
    /// 手工十六进制切片），三条结果一致 —— 见 ADR-0028 的取证记录。
    const EXPECTED_ID: &str = "fobnhpnnampboobopbbdlkkaapbmlonc";

    #[test]
    fn 扩展_id_与公钥对应() {
        let der = base64::engine::general_purpose::STANDARD
            .decode(PUBLIC_KEY_BASE64)
            .expect("公钥应是合法 base64");
        assert_eq!(id_from_public_key(&der), EXPECTED_ID);
    }

    #[test]
    fn manifest_里的_key_算出的就是同一个_id() {
        let id = extension_id().expect("manifest 里必须有 key");
        assert_eq!(id, EXPECTED_ID);
    }

    #[test]
    fn manifest_里的_key_与测试向量一致() {
        assert_eq!(manifest_value("key").as_deref(), Some(PUBLIC_KEY_BASE64));
    }

    #[test]
    fn id_只由公钥决定_与路径无关() {
        // 同一个公钥算两次必须一样（注册表键名是常量）
        let der = base64::engine::general_purpose::STANDARD
            .decode(PUBLIC_KEY_BASE64)
            .unwrap();
        assert_eq!(id_from_public_key(&der), id_from_public_key(&der));
        // 而且必须是 32 个 a..p 的字母
        let id = id_from_public_key(&der);
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| ('a'..='p').contains(&c)), "id={}", id);
    }
}
