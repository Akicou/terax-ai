//! SQLite engine: every operation is a plain function over a `Connection`, so
//! it is testable without Tauri. Another engine (DuckDB) would provide the same
//! set of operations returning the same types.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::config::DbConfig;
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Batch, Connection, OpenFlags, MAIN_DB};
use serde::{Deserialize, Serialize};

use super::sql::{self, Filter, RowAddr, Sort};
use super::value::{cell_from, edit_from, to_sql, Cell, EditValue};

/// Row counts in the sidebar stop here so a huge table never costs a full scan.
pub const COUNT_CAP: u64 = 100_000;
pub const MAX_PAGE_ROWS: u32 = 500;
pub const MAX_QUERY_ROWS: usize = 1_000;

/// Opens an existing database. Never creates a file. Falls back to read-only
/// when the file (or its directory, for the journal) is not writable.
pub fn open(path: &Path, read_only: bool) -> Result<Connection, String> {
    let base = OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = if read_only {
        Connection::open_with_flags(path, base | OpenFlags::SQLITE_OPEN_READ_ONLY)
    } else {
        Connection::open_with_flags(path, base | OpenFlags::SQLITE_OPEN_READ_WRITE)
            .or_else(|_| Connection::open_with_flags(path, base | OpenFlags::SQLITE_OPEN_READ_ONLY))
    }
    .map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    // A database file is untrusted input: its views and triggers must not call
    // functions with side effects, and SQL must not corrupt it through
    // writable_schema or shadow tables.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
        .map_err(|e| e.to_string())?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|e| e.to_string())?;
    // Touch the schema so a file that is not a database fails here, not later.
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn is_read_only(conn: &Connection) -> bool {
    conn.is_readonly(MAIN_DB).unwrap_or(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub decl_type: String,
    pub not_null: bool,
    pub default_value: Option<String>,
    /// 1-based position in the primary key, 0 when not part of it.
    pub pk: u32,
    /// Generated columns are computed and cannot be written.
    pub generated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    /// `c` CREATE INDEX, `u` UNIQUE constraint, `pk` PRIMARY KEY.
    pub origin: String,
    pub partial: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub from: String,
    pub table: String,
    pub to: Option<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInfo {
    pub name: String,
    /// `table`, `view`, `virtual` or `shadow`.
    pub kind: String,
    pub without_rowid: bool,
    /// Whether rows can be edited, inserted and deleted from the grid.
    pub editable: bool,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKey>,
    pub sql: Option<String>,
    pub row_count: Option<u64>,
    pub row_count_capped: bool,
    /// Set when the relation's details could not be read (e.g. a virtual
    /// table whose module is not available).
    pub error: Option<String>,
}

pub fn schema(conn: &Connection) -> Result<Vec<RelationInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.name, l.type, l.wr, s.sql \
             FROM pragma_table_list AS l \
             LEFT JOIN sqlite_schema AS s ON s.name = l.name AND s.type IN ('table', 'view') \
             WHERE l.schema = 'main' AND l.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY l.type = 'view', l.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(name, kind, without_rowid, sql)| relation(conn, name, kind, without_rowid, sql))
        .collect())
}

fn relation(
    conn: &Connection,
    name: String,
    kind: String,
    without_rowid: bool,
    sql: Option<String>,
) -> RelationInfo {
    let mut info = RelationInfo {
        editable: false,
        columns: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        row_count: None,
        row_count_capped: false,
        error: None,
        name,
        kind,
        without_rowid,
        sql,
    };
    let details = (|| -> rusqlite::Result<()> {
        info.columns = columns(conn, &info.name)?;
        if info.kind != "view" {
            info.indexes = indexes(conn, &info.name)?;
            info.foreign_keys = foreign_keys(conn, &info.name)?;
            let (count, capped) = capped_count(conn, &info.name)?;
            info.row_count = Some(count);
            info.row_count_capped = capped;
        }
        Ok(())
    })();
    if let Err(e) = details {
        info.error = Some(e.to_string());
    }
    info.editable = info.error.is_none() && info.kind != "view" && row_addr(&info) != RowAddr::None;
    info
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<ColumnInfo>> {
    let mut stmt = conn.prepare(
        "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?1)",
    )?;
    let rows = stmt.query_map([table], |r| {
        Ok((
            ColumnInfo {
                name: r.get(0)?,
                decl_type: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                not_null: r.get(2)?,
                default_value: r.get(3)?,
                pk: r.get(4)?,
                generated: matches!(r.get::<_, i64>(5)?, 2 | 3),
            },
            r.get::<_, i64>(5)?,
        ))
    })?;
    // hidden = 1 marks virtual-table internals that `SELECT *` does not return.
    rows.filter_map(|r| match r {
        Ok((_, 1)) => None,
        Ok((c, _)) => Some(Ok(c)),
        Err(e) => Some(Err(e)),
    })
    .collect()
}

fn indexes(conn: &Connection, table: &str) -> rusqlite::Result<Vec<IndexInfo>> {
    let mut stmt = conn.prepare(
        "SELECT name, \"unique\", origin, partial FROM pragma_index_list(?1) ORDER BY seq DESC",
    )?;
    let list = stmt
        .query_map([table], |r| {
            Ok(IndexInfo {
                name: r.get(0)?,
                unique: r.get(1)?,
                origin: r.get(2)?,
                partial: r.get(3)?,
                columns: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut cols = conn.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?;
    list.into_iter()
        .map(|mut idx| {
            idx.columns = cols
                .query_map([&idx.name], |r| {
                    // NULL for an expression column.
                    Ok(r.get::<_, Option<String>>(0)?
                        .unwrap_or_else(|| "<expr>".into()))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(idx)
        })
        .collect()
}

fn foreign_keys(conn: &Connection, table: &str) -> rusqlite::Result<Vec<ForeignKey>> {
    let mut stmt = conn.prepare(
        "SELECT \"from\", \"table\", \"to\", on_update, on_delete \
         FROM pragma_foreign_key_list(?1) ORDER BY id, seq",
    )?;
    let rows = stmt.query_map([table], |r| {
        Ok(ForeignKey {
            from: r.get(0)?,
            table: r.get(1)?,
            to: r.get(2)?,
            on_update: r.get(3)?,
            on_delete: r.get(4)?,
        })
    })?;
    rows.collect()
}

fn capped_count(conn: &Connection, table: &str) -> rusqlite::Result<(u64, bool)> {
    let n: i64 = conn.query_row(
        &format!(
            "SELECT count(*) FROM (SELECT 1 FROM {} LIMIT {})",
            sql::quote_ident(table),
            COUNT_CAP + 1
        ),
        [],
        |r| r.get(0),
    )?;
    let n = n.max(0) as u64;
    Ok((n.min(COUNT_CAP), n > COUNT_CAP))
}

fn row_addr(info: &RelationInfo) -> RowAddr {
    if info.kind == "view" {
        return RowAddr::None;
    }
    if info.without_rowid {
        let mut pk: Vec<&ColumnInfo> = info.columns.iter().filter(|c| c.pk > 0).collect();
        pk.sort_by_key(|c| c.pk);
        return RowAddr::Pk(pk.into_iter().map(|c| c.name.clone()).collect());
    }
    let names: Vec<String> = info.columns.iter().map(|c| c.name.clone()).collect();
    sql::rowid_alias(&names).map_or(RowAddr::None, RowAddr::Rowid)
}

fn find_relation(conn: &Connection, table: &str) -> Result<RelationInfo, String> {
    let (kind, without_rowid, sql_text): (String, bool, Option<String>) = conn
        .query_row(
            "SELECT l.type, l.wr, s.sql FROM pragma_table_list AS l \
             LEFT JOIN sqlite_schema AS s ON s.name = l.name AND s.type IN ('table', 'view') \
             WHERE l.schema = 'main' AND l.name = ?1",
            [table],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| format!("no such table: {table}"))?;
    let mut info = RelationInfo {
        name: table.to_string(),
        kind,
        without_rowid,
        sql: sql_text,
        editable: false,
        columns: columns(conn, table).map_err(|e| e.to_string())?,
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        row_count: None,
        row_count_capped: false,
        error: None,
    };
    info.editable = row_addr(&info) != RowAddr::None;
    Ok(info)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub table: String,
    pub offset: u64,
    pub limit: u32,
    pub sort_column: Option<String>,
    #[serde(default)]
    pub sort_desc: bool,
    pub filter_text: Option<String>,
    /// None searches all columns.
    pub filter_column: Option<String>,
    /// Count the matching rows (the grid asks once per table/filter).
    #[serde(default)]
    pub with_total: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// Values addressing the row for edits; empty for read-only relations.
    pub key: Vec<EditValue>,
    pub cells: Vec<Cell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
    pub total: Option<u64>,
}

pub fn rows(conn: &Connection, req: &PageRequest) -> Result<Page, String> {
    let info = find_relation(conn, &req.table)?;
    let columns: Vec<String> = info.columns.iter().map(|c| c.name.clone()).collect();
    let addr = row_addr(&info);
    let has_column = |c: &str| columns.iter().any(|n| n == c);

    let sort = match req.sort_column.as_deref() {
        Some(c) if has_column(c) => Some(Sort {
            column: c,
            desc: req.sort_desc,
        }),
        Some(c) => return Err(format!("no such column: {c}")),
        None => None,
    };
    let pattern = req
        .filter_text
        .as_deref()
        .filter(|t| !t.is_empty() && !columns.is_empty())
        .map(sql::like_contains);
    let filter = match (&pattern, req.filter_column.as_deref()) {
        (None, _) => None,
        (Some(_), Some(c)) if has_column(c) => Some(Filter { column: Some(c) }),
        (Some(_), Some(c)) => return Err(format!("no such column: {c}")),
        (Some(_), None) => Some(Filter { column: None }),
    };

    let limit = req.limit.clamp(1, MAX_PAGE_ROWS) as i64;
    let offset = i64::try_from(req.offset).map_err(|_| "offset out of range")?;
    let mut params: Vec<Value> = Vec::with_capacity(3);
    if let Some(p) = &pattern {
        params.push(Value::Text(p.clone()));
    }
    let total = if req.with_total {
        Some(
            conn.query_row(
                &sql::count_rows(&info.name, &columns, filter),
                params_from_iter(params.iter()),
                |r| r.get::<_, i64>(0).map(|n| n.max(0) as u64),
            )
            .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    params.push(Value::Integer(limit));
    params.push(Value::Integer(offset));

    let key_len = addr.key_columns().len();
    let mut stmt = conn
        .prepare(&sql::select_page(&info.name, &columns, &addr, sort, filter))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |r| {
            let key = (0..key_len)
                .map(|i| r.get_ref(i).map(edit_from))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let cells = (key_len..key_len + columns.len())
                .map(|i| r.get_ref(i).map(cell_from))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Row { key, cells })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(Page {
        columns,
        rows,
        total,
    })
}

#[derive(Debug, Deserialize)]
pub struct ColumnValue {
    pub column: String,
    pub value: EditValue,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Update {
        key: Vec<EditValue>,
        values: Vec<ColumnValue>,
    },
    Insert {
        values: Vec<ColumnValue>,
    },
    Delete {
        key: Vec<EditValue>,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ApplyOutcome {
    Applied {
        count: usize,
    },
    /// Nothing was written; `index` is the change that failed.
    Failed {
        index: usize,
        message: String,
    },
}

/// Applies all changes in one transaction: either every change lands or none.
pub fn apply(
    conn: &mut Connection,
    table: &str,
    changes: &[Change],
) -> Result<ApplyOutcome, String> {
    let info = find_relation(conn, table)?;
    if !info.editable {
        return Err(format!("{table} is read-only"));
    }
    let addr = row_addr(&info);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (index, change) in changes.iter().enumerate() {
        if let Err(message) = apply_one(&tx, &info, &addr, change) {
            // Dropping `tx` rolls back.
            return Ok(ApplyOutcome::Failed { index, message });
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ApplyOutcome::Applied {
        count: changes.len(),
    })
}

fn apply_one(
    conn: &Connection,
    info: &RelationInfo,
    addr: &RowAddr,
    change: &Change,
) -> Result<(), String> {
    let writable = |name: &str| -> Result<(), String> {
        match info.columns.iter().find(|c| c.name == name) {
            None => Err(format!("no such column: {name}")),
            Some(c) if c.generated => Err(format!("{name} is a generated column")),
            Some(_) => Ok(()),
        }
    };
    let key_params = |key: &[EditValue]| -> Result<Vec<Value>, String> {
        if key.len() != addr.key_columns().len() {
            return Err("row key does not match the table".into());
        }
        key.iter().map(to_sql).collect()
    };
    let one_row = |n: usize| match n {
        1 => Ok(()),
        0 => Err("the row no longer exists (changed outside this view?)".to_string()),
        n => Err(format!("{n} rows matched; the row key is not unique")),
    };

    match change {
        Change::Update { key, values } => {
            if values.is_empty() {
                return Ok(());
            }
            let mut params = Vec::with_capacity(values.len() + key.len());
            let mut set = Vec::with_capacity(values.len());
            for cv in values {
                writable(&cv.column)?;
                set.push(cv.column.as_str());
                params.push(to_sql(&cv.value)?);
            }
            params.extend(key_params(key)?);
            let n = conn
                .execute(
                    &sql::update_row(&info.name, &set, addr),
                    params_from_iter(params),
                )
                .map_err(|e| e.to_string())?;
            one_row(n)
        }
        Change::Insert { values } => {
            let mut cols = Vec::with_capacity(values.len());
            let mut params = Vec::with_capacity(values.len());
            for cv in values {
                writable(&cv.column)?;
                cols.push(cv.column.as_str());
                params.push(to_sql(&cv.value)?);
            }
            conn.execute(
                &sql::insert_row(&info.name, &cols),
                params_from_iter(params),
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        }
        Change::Delete { key } => {
            let n = conn
                .execute(
                    &sql::delete_row(&info.name, addr),
                    params_from_iter(key_params(key)?),
                )
                .map_err(|e| e.to_string())?;
            one_row(n)
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    /// Columns of the last statement that returned rows; empty when none did.
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    /// More rows existed than were returned.
    pub truncated: bool,
    /// Rows changed by INSERT/UPDATE/DELETE statements.
    pub changes: u64,
    pub statements: usize,
    /// A statement could have changed data or schema.
    pub wrote: bool,
    pub elapsed_ms: u64,
}

/// Runs one or more statements. A statement that fails stops the batch; the
/// ones before it stay applied, as in the sqlite3 shell.
pub fn query(conn: &Connection, sql_text: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let mut out = QueryResult {
        columns: Vec::new(),
        rows: Vec::new(),
        truncated: false,
        changes: 0,
        statements: 0,
        wrote: false,
        elapsed_ms: 0,
    };
    let mut batch = Batch::new(conn, sql_text);
    while let Some(mut stmt) = batch.next().map_err(|e| e.to_string())? {
        out.statements += 1;
        let read_only = stmt.readonly();
        out.wrote |= !read_only;
        let column_count = stmt.column_count();
        if column_count == 0 {
            let before = conn.total_changes();
            stmt.raw_execute().map_err(|e| e.to_string())?;
            out.changes += conn.total_changes().saturating_sub(before);
            continue;
        }
        let before = conn.total_changes();
        out.columns = stmt.column_names().map(str::to_string).collect();
        out.rows.clear();
        out.truncated = false;
        let mut rows = stmt.raw_query();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if out.rows.len() >= MAX_QUERY_ROWS {
                out.truncated = true;
                // A read can stop early; a write (RETURNING) must run to the end.
                if read_only {
                    break;
                }
                continue;
            }
            out.rows.push(
                (0..column_count)
                    .map(|i| row.get_ref(i).map(cell_from))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|e| e.to_string())?,
            );
        }
        drop(rows);
        out.changes += conn.total_changes().saturating_sub(before);
    }
    if out.statements == 0 {
        return Err("nothing to run".into());
    }
    out.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, data BLOB);
             INSERT INTO users (name, score) VALUES ('ada', 1.5), ('bob', NULL), ('cy_%', 3.0);
             CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
             INSERT INTO kv VALUES ('a', '1'), ('b', '2');
             CREATE TABLE \"we\"\"ird\" (rowid TEXT, x INTEGER);
             INSERT INTO \"we\"\"ird\" VALUES ('r', 1);
             CREATE TABLE gen (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2));
             CREATE VIEW top AS SELECT name FROM users WHERE score > 1;
             CREATE INDEX users_name ON users(name);",
        )
        .unwrap();
        (dir, path)
    }

    fn page(table: &str) -> PageRequest {
        PageRequest {
            table: table.into(),
            offset: 0,
            limit: 100,
            sort_column: None,
            sort_desc: false,
            filter_text: None,
            filter_column: None,
            with_total: true,
        }
    }

    fn text(v: &str) -> EditValue {
        EditValue::Text { v: v.into() }
    }

    #[test]
    fn open_refuses_missing_and_non_database_files() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.db");
        assert!(open(&missing, false).is_err());
        assert!(!missing.exists(), "open must never create a file");
        let junk = dir.path().join("junk.db");
        std::fs::write(&junk, vec![b'x'; 4096]).unwrap();
        assert!(open(&junk, false).is_err());
    }

    #[test]
    fn schema_lists_relations_with_details() {
        let (_d, path) = fixture();
        let conn = open(&path, false).unwrap();
        let s = schema(&conn).unwrap();
        let names: Vec<&str> = s.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["gen", "kv", "users", "we\"ird", "top"]);
        let users = s.iter().find(|r| r.name == "users").unwrap();
        assert!(users.editable);
        assert_eq!(users.row_count, Some(3));
        assert_eq!(users.columns[0].pk, 1);
        assert!(users.columns[1].not_null);
        assert!(users
            .indexes
            .iter()
            .any(|i| i.name == "users_name" && i.columns == ["name"]));
        let kv = s.iter().find(|r| r.name == "kv").unwrap();
        assert!(kv.without_rowid && kv.editable);
        let view = s.iter().find(|r| r.name == "top").unwrap();
        assert_eq!(view.kind, "view");
        assert!(!view.editable);
        let generated = s.iter().find(|r| r.name == "gen").unwrap();
        assert!(generated.columns[1].generated);
    }

    #[test]
    fn pages_sort_and_filter() {
        let (_d, path) = fixture();
        let conn = open(&path, false).unwrap();
        let p = rows(&conn, &page("users")).unwrap();
        assert_eq!(p.columns, ["id", "name", "score", "data"]);
        assert_eq!(p.total, Some(3));
        assert_eq!(p.rows[0].key, [EditValue::Int { v: "1".into() }]);
        assert_eq!(p.rows[1].cells[2], Cell::Null);

        let mut req = page("users");
        req.sort_column = Some("name".into());
        req.sort_desc = true;
        req.limit = 1;
        req.offset = 1;
        let p = rows(&conn, &req).unwrap();
        assert_eq!(p.rows.len(), 1);
        assert_eq!(
            p.rows[0].cells[1],
            Cell::Text {
                v: "bob".into(),
                len: 3,
                truncated: false
            }
        );

        // LIKE wildcards in the filter are literal.
        let mut req = page("users");
        req.filter_text = Some("_%".into());
        let p = rows(&conn, &req).unwrap();
        assert_eq!(p.total, Some(1));
        assert_eq!(p.rows.len(), 1);

        let mut req = page("users");
        req.filter_text = Some("B".into());
        req.filter_column = Some("name".into());
        assert_eq!(rows(&conn, &req).unwrap().total, Some(1));

        let mut req = page("users");
        req.sort_column = Some("nope\"".into());
        assert!(rows(&conn, &req).is_err());
        assert!(rows(&conn, &page("missing")).is_err());
    }

    #[test]
    fn shadowed_rowid_uses_another_alias() {
        let (_d, path) = fixture();
        let mut conn = open(&path, false).unwrap();
        let p = rows(&conn, &page("we\"ird")).unwrap();
        assert_eq!(p.columns, ["rowid", "x"]);
        assert_eq!(p.rows[0].key, [EditValue::Int { v: "1".into() }]);
        let out = apply(
            &mut conn,
            "we\"ird",
            &[Change::Update {
                key: p.rows[0].key.clone(),
                values: vec![ColumnValue {
                    column: "rowid".into(),
                    value: text("s"),
                }],
            }],
        )
        .unwrap();
        assert_eq!(out, ApplyOutcome::Applied { count: 1 });
    }

    #[test]
    fn applies_changes_atomically() {
        let (_d, path) = fixture();
        let mut conn = open(&path, false).unwrap();
        let one = || vec![EditValue::Int { v: "1".into() }];
        let out = apply(
            &mut conn,
            "users",
            &[
                Change::Update {
                    key: one(),
                    values: vec![ColumnValue {
                        column: "name".into(),
                        value: text("ada2"),
                    }],
                },
                Change::Insert {
                    values: vec![ColumnValue {
                        column: "name".into(),
                        value: text("dee"),
                    }],
                },
                // NOT NULL violation: everything above must roll back.
                Change::Insert {
                    values: vec![ColumnValue {
                        column: "name".into(),
                        value: EditValue::Null,
                    }],
                },
            ],
        )
        .unwrap();
        assert!(matches!(out, ApplyOutcome::Failed { index: 2, .. }));
        let name: String = conn
            .query_row("SELECT name FROM users WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "ada");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);

        let out = apply(
            &mut conn,
            "users",
            &[
                Change::Delete { key: one() },
                Change::Insert { values: vec![] },
            ],
        );
        // DEFAULT VALUES violates NOT NULL on name.
        assert!(matches!(out, Ok(ApplyOutcome::Failed { index: 1, .. })));

        let out = apply(&mut conn, "users", &[Change::Delete { key: one() }]).unwrap();
        assert_eq!(out, ApplyOutcome::Applied { count: 1 });
        // A second delete of the same row reports it gone.
        let out = apply(&mut conn, "users", &[Change::Delete { key: one() }]).unwrap();
        assert!(matches!(out, ApplyOutcome::Failed { index: 0, .. }));
    }

    #[test]
    fn edits_without_rowid_tables_by_primary_key() {
        let (_d, path) = fixture();
        let mut conn = open(&path, false).unwrap();
        let out = apply(
            &mut conn,
            "kv",
            &[Change::Update {
                key: vec![text("b")],
                values: vec![ColumnValue {
                    column: "v".into(),
                    value: text("two"),
                }],
            }],
        )
        .unwrap();
        assert_eq!(out, ApplyOutcome::Applied { count: 1 });
        let v: String = conn
            .query_row("SELECT v FROM kv WHERE k = 'b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "two");
    }

    #[test]
    fn rejects_invalid_edits() {
        let (_d, path) = fixture();
        let mut conn = open(&path, false).unwrap();
        assert!(apply(&mut conn, "top", &[]).is_err(), "views are read-only");
        let gen = apply(
            &mut conn,
            "gen",
            &[Change::Insert {
                values: vec![ColumnValue {
                    column: "b".into(),
                    value: EditValue::Int { v: "1".into() },
                }],
            }],
        )
        .unwrap();
        assert!(matches!(gen, ApplyOutcome::Failed { index: 0, .. }));
        let bad_col = apply(
            &mut conn,
            "users",
            &[Change::Insert {
                values: vec![ColumnValue {
                    column: "x\" ; DROP TABLE users; --".into(),
                    value: text(""),
                }],
            }],
        )
        .unwrap();
        assert!(matches!(bad_col, ApplyOutcome::Failed { .. }));
        let bad_int = apply(
            &mut conn,
            "users",
            &[Change::Update {
                key: vec![EditValue::Int { v: "1".into() }],
                values: vec![ColumnValue {
                    column: "id".into(),
                    value: EditValue::Int { v: "one".into() },
                }],
            }],
        )
        .unwrap();
        assert!(matches!(bad_int, ApplyOutcome::Failed { .. }));
    }

    #[test]
    fn read_only_connections_refuse_writes() {
        let (_d, path) = fixture();
        let mut conn = open(&path, true).unwrap();
        assert!(is_read_only(&conn));
        let out = apply(
            &mut conn,
            "users",
            &[Change::Delete {
                key: vec![EditValue::Int { v: "1".into() }],
            }],
        )
        .unwrap();
        assert!(matches!(out, ApplyOutcome::Failed { .. }));
    }

    #[test]
    fn runs_statement_batches() {
        let (_d, path) = fixture();
        let conn = open(&path, false).unwrap();
        let r = query(
            &conn,
            "UPDATE users SET score = 0; SELECT name FROM users ORDER BY id;",
        )
        .unwrap();
        assert_eq!(r.statements, 2);
        assert_eq!(r.changes, 3);
        assert!(r.wrote);
        assert_eq!(r.columns, ["name"]);
        assert_eq!(r.rows.len(), 3);

        let r = query(&conn, "SELECT 1 AS one").unwrap();
        assert!(!r.wrote);

        let r = query(
            &conn,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 5000) SELECT i FROM n",
        )
        .unwrap();
        assert_eq!(r.rows.len(), MAX_QUERY_ROWS);
        assert!(r.truncated);

        assert!(query(&conn, "SELEC nope").is_err());
        assert!(query(&conn, "  -- just a comment\n").is_err());
    }

    #[test]
    fn untrusted_schema_cannot_corrupt_the_file() {
        let (_d, path) = fixture();
        let conn = open(&path, false).unwrap();
        // DEFENSIVE blocks direct schema writes even with writable_schema.
        let _ = query(&conn, "PRAGMA writable_schema = ON");
        assert!(query(&conn, "UPDATE sqlite_schema SET sql = 'x'").is_err());
    }
}
