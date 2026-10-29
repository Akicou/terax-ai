//! Database viewer backend. A tab opens a session (one connection) by handle,
//! reads schema and pages through it, and closes it when the tab goes away.
//! The engine-specific work lives in `sqlite.rs`; this file is the thin shell.

mod sniff;
mod sql;
mod sqlite;
mod value;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, InterruptHandle};
use serde::Serialize;

use crate::modules::fs::blocking;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

use sniff::DbFormat;
pub use sqlite::{ApplyOutcome, Change, Page, PageRequest, QueryResult, RelationInfo};

/// Bounds connections a misbehaving frontend could leak.
const MAX_SESSIONS: usize = 64;

struct Session {
    conn: Mutex<Connection>,
    /// Kept outside the connection lock so a running query can be cancelled.
    interrupt: InterruptHandle,
}

#[derive(Default)]
pub struct DbState {
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    next: AtomicU64,
}

impl DbState {
    fn get(&self, handle: u64) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .map_err(|_| "database state poisoned".to_string())?
            .get(&handle)
            .cloned()
            .ok_or_else(|| "database is closed".to_string())
    }
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OpenResult {
    Ready {
        handle: u64,
        engine: &'static str,
        read_only: bool,
        size: u64,
    },
    /// A database format recognized but not supported yet.
    Unsupported {
        format: &'static str,
    },
    NotADatabase {
        message: String,
    },
}

#[tauri::command]
pub async fn db_open(
    path: String,
    workspace: Option<WorkspaceEnv>,
    read_only: Option<bool>,
    state: tauri::State<'_, DbState>,
) -> Result<OpenResult, String> {
    let opened = blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        let size = std::fs::metadata(&target).map_err(|e| e.to_string())?.len();
        match sniff::sniff_file(&target).map_err(|e| e.to_string())? {
            DbFormat::DuckDb => return Ok(Err(OpenResult::Unsupported { format: "duckdb" })),
            DbFormat::Unknown => {
                return Ok(Err(OpenResult::NotADatabase {
                    message: "This file is not a SQLite database.".into(),
                }))
            }
            DbFormat::Sqlite | DbFormat::Empty => {}
        }
        match sqlite::open(&target, read_only.unwrap_or(false)) {
            Ok(conn) => Ok(Ok((conn, size))),
            Err(message) => Ok(Err(OpenResult::NotADatabase { message })),
        }
    })
    .await?;
    let (conn, size) = match opened {
        Ok(v) => v,
        Err(result) => return Ok(result),
    };

    let read_only = sqlite::is_read_only(&conn);
    let interrupt = conn.get_interrupt_handle();
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "database state poisoned".to_string())?;
    if sessions.len() >= MAX_SESSIONS {
        return Err("too many open databases".into());
    }
    let handle = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    sessions.insert(
        handle,
        Arc::new(Session {
            conn: Mutex::new(conn),
            interrupt,
        }),
    );
    Ok(OpenResult::Ready {
        handle,
        engine: "sqlite",
        read_only,
        size,
    })
}

#[tauri::command]
pub async fn db_close(handle: u64, state: tauri::State<'_, DbState>) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "database state poisoned".to_string())?
        .remove(&handle);
    if let Some(session) = session {
        session.interrupt.interrupt();
        // The connection closes when the last in-flight command drops its Arc,
        // off the IPC thread.
        let _ = blocking(move || {
            drop(session);
            Ok(())
        })
        .await;
    }
    Ok(())
}

async fn with_conn<T, F>(state: &DbState, handle: u64, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
{
    let session = state.get(handle)?;
    blocking(move || {
        let mut conn = session
            .conn
            .lock()
            .map_err(|_| "database connection poisoned".to_string())?;
        work(&mut conn)
    })
    .await
}

#[tauri::command]
pub async fn db_schema(
    handle: u64,
    state: tauri::State<'_, DbState>,
) -> Result<Vec<RelationInfo>, String> {
    with_conn(&state, handle, |conn| sqlite::schema(conn)).await
}

#[tauri::command]
pub async fn db_rows(
    handle: u64,
    request: PageRequest,
    state: tauri::State<'_, DbState>,
) -> Result<Page, String> {
    with_conn(&state, handle, move |conn| sqlite::rows(conn, &request)).await
}

#[tauri::command]
pub async fn db_apply(
    handle: u64,
    table: String,
    changes: Vec<Change>,
    state: tauri::State<'_, DbState>,
) -> Result<ApplyOutcome, String> {
    with_conn(&state, handle, move |conn| {
        sqlite::apply(conn, &table, &changes)
    })
    .await
}

#[tauri::command]
pub async fn db_query(
    handle: u64,
    sql: String,
    state: tauri::State<'_, DbState>,
) -> Result<QueryResult, String> {
    with_conn(&state, handle, move |conn| sqlite::query(conn, &sql)).await
}

#[tauri::command]
pub fn db_interrupt(handle: u64, state: tauri::State<'_, DbState>) -> Result<(), String> {
    state.get(handle)?.interrupt.interrupt();
    Ok(())
}
