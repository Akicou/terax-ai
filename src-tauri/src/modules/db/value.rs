//! Conversions between SQLite values and their IPC shapes.
//!
//! Integers and reals travel as strings: JavaScript numbers lose precision past
//! 2^53, and the exact text is what the grid shows and edits anyway.

use rusqlite::types::{Value, ValueRef};
use serde::{Deserialize, Serialize};

/// Text longer than this is cut for display; the cell is then not editable inline.
pub const TEXT_PREVIEW_BYTES: usize = 64 * 1024;
/// Leading bytes of a blob shown as hex.
pub const BLOB_PREVIEW_BYTES: usize = 32;

/// A value as displayed in the grid.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Cell {
    Null,
    Int {
        v: String,
    },
    Real {
        v: String,
    },
    Text {
        v: String,
        /// Byte length of the full value.
        len: usize,
        truncated: bool,
    },
    Blob {
        size: usize,
        /// Hex of at most BLOB_PREVIEW_BYTES leading bytes.
        hex: String,
    },
}

/// A full value: written by edits and used to address rows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum EditValue {
    Null,
    Int { v: String },
    Real { v: String },
    Text { v: String },
    Blob { hex: String },
}

pub fn cell_from(v: ValueRef<'_>) -> Cell {
    match v {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(i) => Cell::Int { v: i.to_string() },
        ValueRef::Real(r) => Cell::Real { v: format_real(r) },
        ValueRef::Text(bytes) => {
            let len = bytes.len();
            let (shown, truncated) = if len > TEXT_PREVIEW_BYTES {
                (
                    &bytes[..floor_char_boundary(bytes, TEXT_PREVIEW_BYTES)],
                    true,
                )
            } else {
                (bytes, false)
            };
            Cell::Text {
                v: String::from_utf8_lossy(shown).into_owned(),
                len,
                truncated,
            }
        }
        ValueRef::Blob(bytes) => Cell::Blob {
            size: bytes.len(),
            hex: hex_encode(&bytes[..bytes.len().min(BLOB_PREVIEW_BYTES)]),
        },
    }
}

pub fn edit_from(v: ValueRef<'_>) -> EditValue {
    match v {
        ValueRef::Null => EditValue::Null,
        ValueRef::Integer(i) => EditValue::Int { v: i.to_string() },
        ValueRef::Real(r) => EditValue::Real { v: format_real(r) },
        ValueRef::Text(bytes) => EditValue::Text {
            v: String::from_utf8_lossy(bytes).into_owned(),
        },
        ValueRef::Blob(bytes) => EditValue::Blob {
            hex: hex_encode(bytes),
        },
    }
}

pub fn to_sql(v: &EditValue) -> Result<Value, String> {
    Ok(match v {
        EditValue::Null => Value::Null,
        EditValue::Int { v } => Value::Integer(
            v.trim()
                .parse::<i64>()
                .map_err(|_| format!("\"{v}\" is not a valid integer"))?,
        ),
        EditValue::Real { v } => {
            let r = v
                .trim()
                .parse::<f64>()
                .map_err(|_| format!("\"{v}\" is not a valid number"))?;
            if r.is_nan() {
                return Err("NaN cannot be stored".into());
            }
            Value::Real(r)
        }
        EditValue::Text { v } => Value::Text(v.clone()),
        EditValue::Blob { hex } => Value::Blob(hex_decode(hex)?),
    })
}

/// Shortest round-tripping text, always marked as a real (`1.0`, not `1`).
fn format_real(r: f64) -> String {
    if r.is_infinite() {
        return if r > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    format!("{r:?}")
}

fn floor_char_boundary(bytes: &[u8], max: usize) -> usize {
    let mut i = max.min(bytes.len());
    // UTF-8 continuation bytes are 0b10xx_xxxx.
    while i > 0 && i < bytes.len() && (bytes[i] & 0xC0) == 0x80 {
        i -= 1;
    }
    i
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0xF) as usize] as char);
    }
    out
}

pub fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = hex.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let clean = clean
        .strip_prefix(b"0x")
        .or_else(|| clean.strip_prefix(b"0X"))
        .unwrap_or(&clean);
    if !clean.len().is_multiple_of(2) {
        return Err("hex must have an even number of digits".into());
    }
    let nibble = |c: u8| -> Result<u8, String> {
        (c as char)
            .to_digit(16)
            .map(|d| d as u8)
            .ok_or_else(|| format!("'{}' is not a hex digit", c as char))
    };
    clean
        .chunks_exact(2)
        .map(|p| Ok((nibble(p[0])? << 4) | nibble(p[1])?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_integers_keep_precision() {
        let big = i64::MAX;
        assert_eq!(
            cell_from(ValueRef::Integer(big)),
            Cell::Int {
                v: "9223372036854775807".into()
            }
        );
        assert_eq!(
            to_sql(&EditValue::Int {
                v: " 9223372036854775807 ".into()
            })
            .unwrap(),
            Value::Integer(big)
        );
        assert!(to_sql(&EditValue::Int { v: "1.5".into() }).is_err());
        assert!(to_sql(&EditValue::Int { v: "abc".into() }).is_err());
    }

    #[test]
    fn reals_are_marked_and_round_trip() {
        for r in [1.0, 0.1, -2.5e-300, 1e100, f64::MAX] {
            let EditValue::Real { v } = edit_from(ValueRef::Real(r)) else {
                panic!()
            };
            assert_eq!(to_sql(&EditValue::Real { v }).unwrap(), Value::Real(r));
        }
        assert_eq!(format_real(1.0), "1.0");
        assert_eq!(format_real(f64::NEG_INFINITY), "-Infinity");
        assert!(to_sql(&EditValue::Real { v: "NaN".into() }).is_err());
    }

    #[test]
    fn long_text_is_truncated_on_a_char_boundary() {
        let s = "é".repeat(TEXT_PREVIEW_BYTES); // 2 bytes each
        let Cell::Text { v, len, truncated } = cell_from(ValueRef::Text(s.as_bytes())) else {
            panic!()
        };
        assert!(truncated);
        assert_eq!(len, s.len());
        assert!(v.len() <= TEXT_PREVIEW_BYTES);
        assert!(v.chars().all(|c| c == 'é'));
    }

    #[test]
    fn blobs_preview_and_round_trip() {
        let bytes: Vec<u8> = (0..=255).collect();
        let Cell::Blob { size, hex } = cell_from(ValueRef::Blob(&bytes)) else {
            panic!()
        };
        assert_eq!(size, 256);
        assert_eq!(hex.len(), BLOB_PREVIEW_BYTES * 2);
        let EditValue::Blob { hex } = edit_from(ValueRef::Blob(&bytes)) else {
            panic!()
        };
        assert_eq!(hex_decode(&hex).unwrap(), bytes);
        assert_eq!(
            hex_decode("0xDE AD be ef").unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
        assert!(hex_decode("abc").is_err());
        assert!(hex_decode("zz").is_err());
    }
}
