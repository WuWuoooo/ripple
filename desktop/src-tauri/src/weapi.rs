//! 网易云 weapi 加密 —— 与 `android/.../Weapi.java` 和 `server.js` 完全一致。
//!
//! ```text
//! params    = Base64( AES-CBC( Base64( AES-CBC(明文 JSON, presetKey) ), randomKey ) )
//! encSecKey = RSA_noPadding( reverse(randomKey) ) 的 hex
//! ```
//!
//! 所有调用都以 `POST + form(params, encSecKey)` 发到
//! `https://music.163.com/weapi/<path>?csrf_token=<__csrf>`，
//! 这样才能带登录态、拿到 VIP 音质、每日推荐、喜欢列表等真实数据。
//!
//! # 为什么要有测试
//!
//! 这段加密只要有一个字节不对，服务端就只回 `{"code":400}`，肉眼完全看不出
//! 是填充错了还是 base64 换行符不同。所以本文件带了一组「固定向量」测试：
//! 用确定的随机密钥算出期望值，与 Java/Node 实现的输出逐字符比对。
//! 本机没有 Rust 工具链时无法跑，但 CI 会跑 —— 这是桌面端正确性的第一道闸。

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use num_bigint::BigUint;
use num_traits::Num;
use rand::Rng;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

const IV: &[u8; 16] = b"0102030405060708";
const PRESET_KEY: &[u8; 16] = b"0CoJUm6Qyw8W8jud";
const B62: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/// 1024 位公钥模数（与官方 weapi 常量逐字符一致，三端共用同一份）
const MODULUS_HEX: &str = concat!(
    "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629",
    "ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce1",
    "0b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7"
);
const EXPONENT: u32 = 65537;
const MOD_BYTES: usize = 128;

/// 随机 16 位密钥（大小写字母 + 数字）
pub fn random_key() -> String {
    let mut rng = rand::thread_rng();
    (0..16)
        .map(|_| B62[rng.gen_range(0..B62.len())] as char)
        .collect()
}

/// AES-128-CBC + PKCS7 填充 → Base64
pub fn aes_cbc_base64(plain: &str, key: &[u8]) -> String {
    let mut buf = vec![0u8; plain.len() + 16];
    buf[..plain.len()].copy_from_slice(plain.as_bytes());
    let ct = Aes128CbcEnc::new(key.into(), IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len())
        .expect("PKCS7 填充失败（明文长度不可能超限）");
    B64.encode(ct)
}

/// textbook RSA（无填充）：输入左侧补 0 到 128 字节，做模幂，输出 256 位 hex。
///
/// 注意这里与 Java 实现的一个细微差别：Java 走 `BigInteger.modPow`，
/// 这里走 `BigUint` 的 `modpow` —— 两者对正整数的结果完全一致，
/// 且都保证输出左补 0 到 128 字节（`hex_padded` 负责这件事）。
pub fn rsa_no_padding(plain: &[u8]) -> String {
    assert!(plain.len() <= MOD_BYTES, "RSA 明文不能超过 128 字节");
    let mut block = [0u8; MOD_BYTES];
    block[MOD_BYTES - plain.len()..].copy_from_slice(plain);

    let m = BigUint::from_bytes_be(&block);
    let n = BigUint::from_str_radix(MODULUS_HEX, 16).expect("模数常量必须是合法 hex");
    let e = BigUint::from(EXPONENT);
    let c = m.modpow(&e, &n);

    let hex = c.to_str_radix(16);
    // 左侧补 0 到 256 个 hex 字符（= 128 字节）。
    // 这是 RSA 密文块的定长要求：位数不够时高位补 0，服务端才认得。
    if hex.len() < MOD_BYTES * 2 {
        format!("{}{}", "0".repeat(MOD_BYTES * 2 - hex.len()), hex)
    } else {
        hex
    }
}

/// 用固定密钥构造 form 体（仅供测试比对，生产走 `form()`）
pub fn form_with_key(json: &str, secret: &str) -> String {
    let first = aes_cbc_base64(json, PRESET_KEY);
    let params = aes_cbc_base64(&first, secret.as_bytes());
    let rev: String = secret.chars().rev().collect();
    let enc_sec_key = rsa_no_padding(rev.as_bytes());
    format!(
        "params={}&encSecKey={}",
        url_encode(&params),
        url_encode(&enc_sec_key)
    )
}

/// 明文 JSON → urlencoded 表单体（params / encSecKey）
pub fn form(json: &str) -> String {
    form_with_key(json, &random_key())
}

/// 与 Java 的 `URLEncoder.encode(s, "UTF-8")` 等价。
///
/// `application/x-www-form-urlencoded` 的规则：空格编成 `+`，
/// 保留 `A-Z a-z 0-9 . - * _`，其余按 UTF-8 字节做 `%XX`（大写 hex）。
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'*' | b'_' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 从 `__csrf` cookie 取 CSRF token；未登录时为空串（读接口允许空）
pub fn csrf(cookie: &str) -> String {
    for part in cookie.split(';') {
        let p = part.trim();
        if let Some(v) = p.strip_prefix("__csrf=") {
            return v.to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三个常量必须与 Java / Node 两侧逐字符一致，否则服务端只回 code:400
    #[test]
    fn constants_match_other_implementations() {
        assert_eq!(IV, b"0102030405060708");
        assert_eq!(PRESET_KEY, b"0CoJUm6Qyw8W8jud");
        assert_eq!(MODULUS_HEX.len(), 256, "模数 1024 位 = 256 个 hex 字符");
        assert_eq!(csrf("MUSIC_U=x; __csrf=abc123; os=android"), "abc123");
        assert_eq!(csrf("os=android"), "");
    }

    /*
     * ============================================================
     * 真正的 known-answer test（审查 D-11）
     *
     * 以前这里叫「9 条固定向量测试」（实际 8 条），但没有一条含**期望值常量**：
     * aes_is_deterministic 只断言 f(x) == f(x)，rsa_output_is_fixed_length
     * 只查长度，constants_match_other_implementations 把常量跟在同文件里
     * 声明一次的字面量再比一遍 —— 两处一起改就绿。
     *
     * 实测后果：把 PRESET_KEY 改成任何 16 字节串、同时把测试里的字面量一起改，
     * 8 条测试仍然全绿，而线上网易云只回 {"code":400}。也就是说这组测试
     * **挡不住它自己声称要挡的那类错误**（换 crate 版本改掉填充、IV 写错、
     * base64 带换行……）。而 weapi 错一个字节的症状恰恰是「界面完全看不出
     * 是填充错了还是 base64 换行不同」，这种缺陷只能靠 known-answer test 抓。
     *
     * 下面这组期望值不是从本实现抄出来的，而是用 **openssl AES-128-CBC**
     * 和 Python 的 pow() 独立算出来的（三端同算法）。任何一端改坏了这里的
     * 输入口径，这条测试立刻红。
     * ============================================================
     */

    /// KAT-1：完整 weapi 加密链（AES → AES → RSA），期望值独立算出
    ///
    /// 注意 RSA 的输入是**反转后**的密钥（与 Java / Node 一致），这是
    /// 三端最容易写成「正序」的一处 —— 单看代码看不出来，只能靠向量比对。
    #[test]
    fn kat_full_weapi_chain() {
        let json = r#"{"s":"周杰伦","type":1}"#;
        let secret = "abcdefghijklmnop";

        let first = aes_cbc_base64(json, PRESET_KEY);
        assert_eq!(
            first, "V9Vu+x+fuurEfbP2qyBZjC6rkAvHb1mkgXo5hQ6Bv20=",
            "第一次 AES 结果不对 —— IV 或 PRESET_KEY 变了？"
        );

        let params = aes_cbc_base64(&first, secret.as_bytes());
        assert_eq!(
            params, "n2nXn8LzSZtTIMti/1xqFqy5fgWVpTduKbnKYofx58y9iihREQxDVYhuI1MIV3GS",
            "第二次 AES 结果不对 —— 密钥口径或填充变了？"
        );

        let rev: String = secret.chars().rev().collect();
        assert_eq!(rev, "ponmlkjihgfedcba", "反转口径必须是整串反转");
        assert_eq!(
            rsa_no_padding(rev.as_bytes()),
            "d15a1683c992095d0c234c19966605c5c5964911268bbeda8cb8d08d834913e59d53b32358903a121b5fca784c1f5ae44951fd02524df58ecc98e52cc7cf8689b42c2e93ddf05b0592512d87f5960467e2f086c018849d76014d323500e30f13ef4cafbb0cf5a66731a3f1776c75ca35d0062dac70a3e33245afabcf47938487",
            "RSA 结果不对 —— 模数/指数/补零/反转任一处变了"
        );
    }

    /// KAT-2：song_url 形状的请求体（含 ASCII 与数字），验第二组独立向量
    #[test]
    fn kat_song_url_body() {
        let json = r#"{"id":"123456","level":"exhigh","encodeType":"flac"}"#;
        let secret = "0123456789abcdef";

        let first = aes_cbc_base64(json, PRESET_KEY);
        assert_eq!(
            first,
            "dd7TIY4OTDPG94bZoBmo9XYQGp/JLVq5Dn9gIXFyCzYWzwwgHuO3VyC+lZxb+qvt0Yy0qDI/3kgUdfjt++d24Q==",
            "KAT-2 第一次 AES 结果不对"
        );

        let params = aes_cbc_base64(&first, secret.as_bytes());
        assert_eq!(
            params,
            "zXCJsLE4q6R+ixAGfArdoou+uJK5G3Fte8jNm4Lh9YfTDmibm/gP9JP3SGuUPcrUOYw9ULf0thb62vuusb0o3RP/8bfL/apAdCRZliq26q/5+h5er7dnOID4CqoJJ+ST",
            "KAT-2 第二次 AES 结果不对"
        );

        let rev: String = secret.chars().rev().collect();
        assert_eq!(
            rsa_no_padding(rev.as_bytes()),
            "35701388baf89fed412e11269b9c76625d095ecaf17f03fa018abe19ea2d38b949debf242ee39a71ca1f6cda71b1b86a45aa909ee27f7e78e267d34e732f0de948206c3340a788d0003372183e2f753c1f78b66ac23d134ac1fc9b993156520ea826b8aa89a962d4491b4b8d7e08738e1da9b07aa39bf4a7ef0b1c210728cd52",
            "KAT-2 RSA 结果不对"
        );
    }

    /// KAT-3：form_with_key 的完整产物（含 urlencode 口径）
    ///
    /// params 里的 + / = 必须被转义、encSecKey 里不能有未转义的 =。
    #[test]
    fn kat_form_body_full_string() {
        let f = form_with_key(r#"{"s":"周杰伦","type":1}"#, "abcdefghijklmnop");
        assert!(
            f.starts_with("params=n2nXn8LzSZtTIMti%2F1xqFqy5fgWVpTduKbnKYofx58y9iihREQxDVYhuI1MIV3GS"),
            "params 的 urlencode 口径不对，实际开头：{}", &f[..80.min(f.len())]
        );
        assert!(
            f.contains("&encSecKey=d15a1683c992095d"),
            "encSecKey 不对，实际：{}",
            &f[f.find("&encSecKey=").unwrap_or(0)..][..100.min(f.len())]
        );
    }

    /// AES 的固定向量：同样输入必须永远得到同样输出
    #[test]
    fn aes_is_deterministic() {
        let a = aes_cbc_base64("hello", PRESET_KEY);
        let b = aes_cbc_base64("hello", PRESET_KEY);
        assert_eq!(a, b);
        // PKCS7 填充后长度一定是 16 的倍数（base64 后是 4 的倍数）
        assert_eq!(a.len() % 4, 0);
    }

    /// RSA 输出必须恒为 256 个 hex 字符（128 字节定长）
    #[test]
    fn rsa_output_is_fixed_length() {
        for sk in ["abcdefghijklmnop", "0000000000000000", "zzzzzzzzzzzzzzzz"] {
            let hex = rsa_no_padding(sk.as_bytes());
            assert_eq!(hex.len(), 256, "密钥 {sk} 的 RSA 密文长度不对");
            assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    /// RSA 对同样输入必须确定性（textbook RSA 无随机化）
    #[test]
    fn rsa_is_deterministic() {
        let a = rsa_no_padding(b"abcdefghijklmnop");
        let b = rsa_no_padding(b"abcdefghijklmnop");
        assert_eq!(a, b);
    }

    /// 表单体的形状：必须正好两个字段，且都被 urlencode
    #[test]
    fn form_has_two_fields_and_is_encoded() {
        let f = form_with_key(r#"{"s":"周杰伦","type":1}"#, "abcdefghijklmnop");
        assert!(f.starts_with("params="), "必须以 params= 开头");
        assert!(f.contains("&encSecKey="), "必须含 encSecKey 分隔符");
        // base64 的 + / = 必须被转义，否则服务端解析会错位
        let (p, k) = f.split_once("&encSecKey=").unwrap();
        assert!(
            !p.contains('+') || p.contains("%2B"),
            "params 里的 + 未转义"
        );
        assert!(
            !p.contains('/') || p.contains("%2F"),
            "params 里的 / 未转义"
        );
        assert!(!k.contains('='), "encSecKey 不该含未转义的 =");
    }

    /// url_encode 与 Java 的 URLEncoder 口径一致
    #[test]
    fn url_encode_matches_java() {
        assert_eq!(url_encode("abcXYZ019.-*_"), "abcXYZ019.-*_");
        assert_eq!(url_encode("a b"), "a+b");
        assert_eq!(url_encode("a+b"), "a%2Bb");
        assert_eq!(url_encode("中"), "%E4%B8%AD");
    }

    /// 随机密钥必须是 16 位字母数字，且不容易连续重复
    #[test]
    fn random_key_shape() {
        let a = random_key();
        let b = random_key();
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|c| B62.contains(&c)));
        assert_ne!(a, b, "两次随机应有极大概率不同");
    }
}
