//! 字形引擎验证程序（对照 TS 版）。
//!
//! 用法：
//!   cargo run --release --bin glyph-check -- \
//!     <站点字体.ttf> <真值.json> <参考库.crdb 或 .crdb.gz>
//!
//! 跑的是**和 TS 侧完全同口径**的流程：
//!   解析字体 → 逐码位栅格化 → 量化 → 自身距离预筛 → 最近邻 → 常用字先验 → 字体级闸门 → 逐字闸门
//!
//! 输出：每个字的对/错，以及总准确率 —— 用来跟 `npm run test:core` 里的
//! TS 侧回归对拍（两边必须一字不差）。

use std::collections::HashMap;

use simuinput_tauri::glyph::{
    db::FastGlyphMatcher, db::GlyphDb, font::coverage_for_char, policy::pick_candidate,
    policy::Thresholds, raster::quantize, raster::RasterWindow,
};
use ttf_parser::Face;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("用法: glyph-check <站点字体.ttf> <真值.json> <参考库.crdb[.gz]>");
        std::process::exit(2);
    }
    let font_path = &args[1];
    let truth_path = &args[2];
    let db_path = &args[3];

    // ── 真值 ──
    let truth_raw = std::fs::read_to_string(truth_path).expect("读真值失败");
    let truth: HashMap<String, String> = parse_truth(&truth_raw);

    // ── 参考库 ──
    let db_bytes = std::fs::read(db_path).expect("读参考库失败");
    let db_bytes = if db_path.ends_with(".gz") {
        use std::io::Read;
        let mut d = flate2::read::GzDecoder::new(&db_bytes[..]);
        let mut out = Vec::new();
        d.read_to_end(&mut out).expect("解压失败");
        out
    } else {
        db_bytes
    };
    let db = GlyphDb::deserialize(&db_bytes).expect("解析参考库失败");
    let matcher = FastGlyphMatcher::new(db);
    let t = Thresholds::default();

    // ── 站点字体 ──
    let font_bytes = std::fs::read(font_path).expect("读字体失败");
    let face = Face::parse(&font_bytes, 0).expect("解析字体失败");
    let window = RasterWindow::CANONICAL;

    // ── 逐码位匹配 ──
    let mut per_char: Vec<(u32, Option<u32>, f32, f32, f32)> = Vec::new();
    let mut cmap_pairs: Vec<u32> = Vec::new();
    if let Some(cmap) = face.tables().cmap {
        for subtable in cmap.subtables {
            subtable.codepoints(|cp| cmap_pairs.push(cp));
        }
    }
    cmap_pairs.sort_unstable();
    cmap_pairs.dedup();

    for codepoint in &cmap_pairs {
        if *codepoint < 0x20 {
            continue;
        }
        let ch = match char::from_u32(*codepoint) {
            Some(c) => c,
            None => continue,
        };
        // glyph id 0 = .notdef，跳过（与 TS 侧 `!glyphId` 一致）
        match face.glyph_index(ch) {
            Some(gid) if gid.0 != 0 => {}
            _ => continue,
        }
        let coverage = match coverage_for_char(&face, ch, 48, window) {
            Some(c) => c,
            None => continue,
        };
        let coverage = quantize(&coverage);

        let db = matcher.db();
        let self_distance = match db.index_of_codepoint(*codepoint) {
            Some(idx) => db.distance_to_index(idx, &coverage),
            None => 1.0,
        };
        if self_distance < t.replace_self_distance {
            per_char.push((*codepoint, None, 0.0, 0.0, self_distance));
            continue;
        }
        let raw = matcher.lookup(&coverage, t.max_candidates);
        let picked = pick_candidate(&raw, &t);
        per_char.push((
            *codepoint,
            picked.codepoint,
            picked.score,
            picked.margin,
            self_distance,
        ));
    }

    // ── 字体级闸门 ──
    let fit = per_char
        .iter()
        .filter(|item| {
            let (cp, plain, score, margin, self_d) = **item;
            match plain {
                Some(p) => {
                    p != cp
                        && score >= t.min_prefetch_score
                        && margin >= t.replace_min_margin
                        && self_d >= t.replace_self_distance
                }
                None => false,
            }
        })
        .count();
    let ratio = if per_char.is_empty() {
        0.0
    } else {
        fit as f32 / per_char.len() as f32
    };

    // ── 逐字闸门 → 映射表 ──
    let mut mapping: HashMap<u32, u32> = HashMap::new();
    for (cp, plain, score, margin, self_d) in &per_char {
        let Some(plain) = plain else { continue };
        if *plain == *cp {
            continue;
        }
        if *self_d < t.replace_self_distance {
            continue;
        }
        if *score < t.replace_min_score {
            continue;
        }
        if *margin < t.replace_min_margin {
            continue;
        }
        mapping.insert(*cp, *plain);
    }

    // ── dump 模式：输出 JSON 映射（用于和 TS 引擎逐条对拍）──
    if let Some(dump_path) = std::env::var("GLYPH_DUMP").ok() {
        let mut obj = serde_json::Map::new();
        for (cp, plain) in &mapping {
            obj.insert(cp.to_string(), serde_json::json!(plain));
        }
        std::fs::write(&dump_path, serde_json::to_string(&serde_json::Value::Object(obj)).unwrap()).unwrap();
        println!("已写出映射: {}", dump_path);
    }

    // ── 对拍真值 ──
    let mut right = 0usize;
    let mut wrong = 0usize;
    let mut missed = 0usize;
    let mut wrong_list: Vec<String> = Vec::new();
    for (cipher, plain) in &truth {
        let cp = cipher.chars().next().unwrap() as u32;
        let expect = plain.chars().next().unwrap() as u32;
        match mapping.get(&cp) {
            Some(got) if *got == expect => right += 1,
            Some(got) => {
                wrong += 1;
                if wrong_list.len() < 12 {
                    wrong_list.push(format!(
                        "{}→{}（应 {}）",
                        cipher,
                        char::from_u32(*got).unwrap_or('?'),
                        plain
                    ));
                }
            }
            None => missed += 1,
        }
    }

    let total = truth.len();
    println!("字体: {}  参考库: {} 字  字体级拟合率: {:.2}", font_path, matcher.db().count, ratio);
    println!(
        "准确率: {}/{}  ({:.1}%)  认错 {}  未识别 {}",
        right,
        total,
        right as f32 * 100.0 / total.max(1) as f32,
        wrong,
        missed
    );
    if !wrong_list.is_empty() {
        println!("  认错的: {}", wrong_list.join("  "));
    }
    if right + wrong != total {
        println!("  （未识别 {} 个: 码位在字体里没有轮廓，或被闸门挡下）", missed);
    }
    if wrong == 0 && missed == 0 {
        println!("✅ 与真值完全一致");
    }
}

/// 解析真值 JSON：`{"truth": {"密文": "明文", ...}}`
fn parse_truth(raw: &str) -> HashMap<String, String> {
    let v: serde_json::Value = serde_json::from_str(raw).expect("真值 JSON 解析失败");
    let obj = v.get("truth").unwrap_or(&v);
    let mut out = HashMap::new();
    if let serde_json::Value::Object(map) = obj {
        for (k, val) in map {
            if let serde_json::Value::String(sv) = val {
                out.insert(k.clone(), sv.clone());
            }
        }
    }
    out
}
