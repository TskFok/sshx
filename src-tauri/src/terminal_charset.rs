//! 终端字符集：远端 locale，以及非 UTF-8 会话的输入输出转码。
//!
//! 本机 `ssh` 进程保持 `LC_ALL=C`，主机校验日志语言不变。macOS 系统配置会把
//! `LANG` / `LC_*` 转发给远端，因此交互会话再用 `SetEnv` 覆盖成用户选择的字符集。
//! OpenSSH 先发送 `SendEnv`，再发送 `SetEnv`，后写的值生效。
//! OpenSSH 只采用第一条 `SetEnv`，后续 `-o SetEnv=...` 会被忽略，
//! 因此所有变量必须写在同一条里。

use encoding_rs::{CoderResult, Decoder, Encoder, EncoderResult, Encoding};

pub fn normalize_terminal_charset(value: &str) -> &'static str {
    let compact: String = value
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect();
    match compact.replace('_', "-").as_str() {
        "utf-8" | "utf8" => "utf-8",
        "gbk" => "gbk",
        "gb2312" | "gb-2312" => "gb2312",
        "gb18030" | "gb-18030" => "gb18030",
        "big5" | "big-5" => "big5",
        _ => "utf-8",
    }
}

pub fn remote_locale(charset: &str) -> &'static str {
    match normalize_terminal_charset(charset) {
        "gbk" => "zh_CN.GBK",
        "gb2312" => "zh_CN.GB2312",
        "gb18030" => "zh_CN.GB18030",
        "big5" => "zh_TW.BIG5",
        _ => "en_US.UTF-8",
    }
}

pub fn append_openssh_setenv(args: &mut Vec<String>, charset: &str) {
    let locale = remote_locale(charset);
    args.push("-o".to_string());
    args.push(format!("SetEnv=LANG={locale} LC_ALL={locale}"));
}

fn encoding_for(charset: &str) -> Option<&'static Encoding> {
    match normalize_terminal_charset(charset) {
        "gbk" | "gb2312" => Some(encoding_rs::GBK),
        "gb18030" => Some(encoding_rs::GB18030),
        "big5" => Some(encoding_rs::BIG5),
        _ => None,
    }
}

pub struct CharsetDecoder {
    decoder: Option<Decoder>,
}

impl CharsetDecoder {
    pub fn new(charset: &str) -> Self {
        Self {
            decoder: encoding_for(charset).map(Encoding::new_decoder),
        }
    }

    /// 远端字节转为 UTF-8。UTF-8 字符集原样返回，不替换非法序列。
    pub fn decode(&mut self, mut input: &[u8]) -> Vec<u8> {
        let Some(decoder) = self.decoder.as_mut() else {
            return input.to_vec();
        };
        let mut output = Vec::new();
        while !input.is_empty() {
            let needed = decoder
                .max_utf8_buffer_length(input.len())
                .unwrap_or(input.len().saturating_mul(3).saturating_add(16));
            let start = output.len();
            output.resize(start + needed.max(4), 0);
            let (result, read, written, _) =
                decoder.decode_to_utf8(input, &mut output[start..], false);
            output.truncate(start + written);
            input = &input[read..];
            if read == 0 {
                match result {
                    CoderResult::OutputFull => continue,
                    CoderResult::InputEmpty => break,
                }
            }
        }
        output
    }
}

pub struct CharsetEncoder {
    encoder: Option<Encoder>,
    pending: Vec<u8>,
}

impl CharsetEncoder {
    pub fn new(charset: &str) -> Self {
        Self {
            encoder: encoding_for(charset).map(Encoding::new_encoder),
            pending: Vec::new(),
        }
    }

    /// 前端 UTF-8 输入转为远端字符集。不完整的 UTF-8 尾字节留到下一块。
    pub fn encode(&mut self, input: &[u8]) -> Vec<u8> {
        let Some(encoder) = self.encoder.as_mut() else {
            return input.to_vec();
        };
        self.pending.extend_from_slice(input);
        let mut output = Vec::new();
        loop {
            if self.pending.is_empty() {
                break;
            }
            let (valid_end, invalid_len) = match std::str::from_utf8(&self.pending) {
                Ok(_) => (self.pending.len(), None),
                Err(error) => (error.valid_up_to(), error.error_len()),
            };
            if valid_end > 0 {
                let text = std::str::from_utf8(&self.pending[..valid_end]).unwrap();
                encode_utf8(encoder, text, &mut output);
                self.pending.drain(..valid_end);
            }
            match invalid_len {
                None => break,
                Some(len) => {
                    encode_utf8(encoder, "\u{FFFD}", &mut output);
                    let drop_len = len.min(self.pending.len());
                    self.pending.drain(..drop_len);
                    if drop_len == 0 {
                        break;
                    }
                }
            }
        }
        output
    }
}

fn encode_utf8(encoder: &mut Encoder, mut text: &str, output: &mut Vec<u8>) {
    while !text.is_empty() {
        let needed = encoder
            .max_buffer_length_from_utf8_without_replacement(text.len())
            .unwrap_or(text.len().saturating_mul(2).saturating_add(16));
        let mut buf = vec![0u8; needed.max(4)];
        let (result, read, written) =
            encoder.encode_from_utf8_without_replacement(text, &mut buf, false);
        output.extend_from_slice(&buf[..written]);
        text = &text[read..];
        match result {
            EncoderResult::InputEmpty => break,
            EncoderResult::OutputFull => {
                if read == 0 {
                    break;
                }
            }
            // `read` 已包含无法映射的字符，剩余输入从它之后开始。
            EncoderResult::Unmappable(_) => {
                output.push(b'?');
                if read == 0 {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_charset_falls_back_to_utf8_locale() {
        assert_eq!(normalize_terminal_charset(" UTF8 "), "utf-8");
        assert_eq!(normalize_terminal_charset("nope"), "utf-8");
        assert_eq!(remote_locale(""), "en_US.UTF-8");
        assert_eq!(remote_locale("gbk"), "zh_CN.GBK");
        assert_eq!(remote_locale("GB2312"), "zh_CN.GB2312");
        assert_eq!(remote_locale("gb18030"), "zh_CN.GB18030");
        assert_eq!(remote_locale("Big5"), "zh_TW.BIG5");
    }

    #[test]
    fn openssh_setenv_overrides_forwarded_locale() {
        let mut args = Vec::new();
        append_openssh_setenv(&mut args, "utf-8");
        assert_eq!(
            args,
            vec!["-o", "SetEnv=LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8"]
        );
    }

    #[test]
    fn utf8_bytes_pass_through_including_invalid_sequences() {
        let mut decoder = CharsetDecoder::new("utf-8");
        let mut encoder = CharsetEncoder::new("utf-8");
        assert_eq!(decoder.decode(&[0xff, 0xfe]), vec![0xff, 0xfe]);
        assert_eq!(encoder.encode("中".as_bytes()), "中".as_bytes());
    }

    #[test]
    fn gbk_roundtrip_keeps_characters_split_across_chunks() {
        let mut encoder = CharsetEncoder::new("gbk");
        assert_eq!(encoder.encode("中".as_bytes()), vec![0xD6, 0xD0]);
        assert_eq!(encoder.encode("A🙂B".as_bytes()), b"A?B");

        let mut split = CharsetEncoder::new("gbk");
        let utf8 = "中".as_bytes();
        assert!(split.encode(&utf8[..2]).is_empty());
        assert_eq!(split.encode(&utf8[2..]), vec![0xD6, 0xD0]);

        let mut decoder = CharsetDecoder::new("gbk");
        assert!(decoder.decode(&[0xD6]).is_empty());
        assert_eq!(decoder.decode(&[0xD0]), "中".as_bytes());
    }

    #[test]
    fn gb18030_and_big5_roundtrip() {
        for charset in ["gb18030", "gb2312", "big5"] {
            let mut encoder = CharsetEncoder::new(charset);
            let mut decoder = CharsetDecoder::new(charset);
            let encoded = encoder.encode("文".as_bytes());
            assert!(!encoded.is_empty(), "{charset}");
            assert_eq!(decoder.decode(&encoded), "文".as_bytes(), "{charset}");
        }
    }
}
