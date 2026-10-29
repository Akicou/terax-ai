//! Identifies a database file from its first bytes, before any engine opens it.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Bytes needed to tell the supported formats apart.
pub const HEADER_LEN: usize = 16;

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
/// DuckDB writes its magic after an 8-byte checksum.
const DUCKDB_MAGIC: &[u8; 4] = b"DUCK";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbFormat {
    Sqlite,
    DuckDb,
    /// A zero-length file is a valid, empty SQLite database.
    Empty,
    Unknown,
}

pub fn sniff(header: &[u8]) -> DbFormat {
    if header.is_empty() {
        DbFormat::Empty
    } else if header.starts_with(SQLITE_MAGIC) {
        DbFormat::Sqlite
    } else if header.len() >= 12 && &header[8..12] == DUCKDB_MAGIC {
        DbFormat::DuckDb
    } else {
        DbFormat::Unknown
    }
}

pub fn sniff_file(path: &Path) -> std::io::Result<DbFormat> {
    let mut buf = Vec::with_capacity(HEADER_LEN);
    File::open(path)?
        .take(HEADER_LEN as u64)
        .read_to_end(&mut buf)?;
    Ok(sniff(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_formats() {
        assert_eq!(sniff(b""), DbFormat::Empty);
        assert_eq!(sniff(b"SQLite format 3\0\x10\x00"), DbFormat::Sqlite);
        assert_eq!(
            sniff(b"\x01\x02\x03\x04\x05\x06\x07\x08DUCK\x40\0\0\0"),
            DbFormat::DuckDb
        );
        assert_eq!(sniff(b"SQLite format 2\0"), DbFormat::Unknown);
        assert_eq!(sniff(b"short"), DbFormat::Unknown);
        assert_eq!(sniff(b"hello world, plain text"), DbFormat::Unknown);
    }

    #[test]
    fn sniffs_files() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty.db");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(sniff_file(&empty).unwrap(), DbFormat::Empty);
        let text = dir.path().join("text.db");
        std::fs::write(&text, b"not a database at all").unwrap();
        assert_eq!(sniff_file(&text).unwrap(), DbFormat::Unknown);
        assert!(sniff_file(&dir.path().join("missing.db")).is_err());
    }
}
