//! 库入口。
//!
//! 桌面端把逻辑都放在 `main.rs` 里（单二进制，没有移动端那种
//! 「lib + jni 桥」的双层结构），这个 `lib.rs` 只是为了满足
//! `Cargo.toml` 里的 `[lib]` 声明，让 `cargo test` 能跑单元测试
//! （`weapi`、`netease` 的测试都在这里被编到）。

pub mod netease;
pub mod weapi;
