//! SQL text builders. Identifiers are always quoted and values are always bound
//! as parameters, so no caller-supplied string is ever spliced into SQL as code.

/// Quotes an identifier for SQLite: `a"b` becomes `"a""b"`.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// How rows of a relation are addressed for edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowAddr {
    /// An ordinary table. The name is whichever of `rowid`, `_rowid_` and `oid`
    /// is not shadowed by a real column.
    Rowid(&'static str),
    /// A `WITHOUT ROWID` table, addressed by its primary-key columns in order.
    Pk(Vec<String>),
    /// A view, or a table no alias reaches: read-only.
    None,
}

impl RowAddr {
    pub fn key_columns(&self) -> Vec<String> {
        match self {
            RowAddr::Rowid(alias) => vec![(*alias).to_string()],
            RowAddr::Pk(cols) => cols.clone(),
            RowAddr::None => Vec::new(),
        }
    }

    fn key_exprs(&self) -> Vec<String> {
        match self {
            RowAddr::Rowid(alias) => vec![(*alias).to_string()],
            RowAddr::Pk(cols) => cols.iter().map(|c| quote_ident(c)).collect(),
            RowAddr::None => Vec::new(),
        }
    }

    /// `WHERE` body matching one row, with `?` placeholders for the key values.
    fn match_clause(&self) -> String {
        self.key_exprs()
            .iter()
            .map(|e| format!("{e} IS ?"))
            .collect::<Vec<_>>()
            .join(" AND ")
    }
}

/// The rowid alias to use for a table with these columns, if any is free.
pub fn rowid_alias(columns: &[String]) -> Option<&'static str> {
    ["rowid", "_rowid_", "oid"]
        .into_iter()
        .find(|alias| !columns.iter().any(|c| c.eq_ignore_ascii_case(alias)))
}

#[derive(Debug, Clone, Copy)]
pub struct Sort<'a> {
    pub column: &'a str,
    pub desc: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Filter<'a> {
    /// None searches every column.
    pub column: Option<&'a str>,
}

/// `LIKE` pattern matching `text` anywhere, with `\` as the escape character.
pub fn like_contains(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// `WHERE ...` using parameter `?1` for the pattern, or empty without a filter.
fn where_filter(columns: &[String], filter: Option<Filter<'_>>) -> String {
    let Some(filter) = filter else {
        return String::new();
    };
    let targets: Vec<&str> = match filter.column {
        Some(c) => vec![c],
        None => columns.iter().map(String::as_str).collect(),
    };
    if targets.is_empty() {
        return String::new();
    }
    let ors = targets
        .iter()
        .map(|c| format!("{} LIKE ?1 ESCAPE '\\'", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!(" WHERE ({ors})")
}

/// One page of rows: the key columns first, then `columns`. With a filter the
/// parameters are pattern, limit, offset; without one, limit and offset.
pub fn select_page(
    table: &str,
    columns: &[String],
    addr: &RowAddr,
    sort: Option<Sort<'_>>,
    filter: Option<Filter<'_>>,
) -> String {
    let mut select: Vec<String> = addr.key_exprs();
    select.extend(columns.iter().map(|c| quote_ident(c)));
    if select.is_empty() {
        select.push("*".into());
    }
    let mut order: Vec<String> = Vec::new();
    if let Some(s) = sort {
        order.push(format!(
            "{} {}",
            quote_ident(s.column),
            if s.desc { "DESC" } else { "ASC" }
        ));
    }
    // Key tiebreak keeps paging stable under a sort with duplicates.
    order.extend(addr.key_exprs());
    let order = if order.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order.join(", "))
    };
    let where_sql = where_filter(columns, filter);
    let limit = if where_sql.is_empty() {
        " LIMIT ?1 OFFSET ?2"
    } else {
        " LIMIT ?2 OFFSET ?3"
    };
    format!(
        "SELECT {} FROM {}{where_sql}{order}{limit}",
        select.join(", "),
        quote_ident(table)
    )
}

/// Row count under the same filter; `?1` is the filter pattern if any.
pub fn count_rows(table: &str, columns: &[String], filter: Option<Filter<'_>>) -> String {
    format!(
        "SELECT count(*) FROM {}{}",
        quote_ident(table),
        where_filter(columns, filter)
    )
}

/// `UPDATE` of `set` columns: their values first, then the key values.
pub fn update_row(table: &str, set: &[&str], addr: &RowAddr) -> String {
    let assigns = set
        .iter()
        .map(|c| format!("{} = ?", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "UPDATE {} SET {assigns} WHERE {}",
        quote_ident(table),
        addr.match_clause()
    )
}

pub fn insert_row(table: &str, columns: &[&str]) -> String {
    if columns.is_empty() {
        return format!("INSERT INTO {} DEFAULT VALUES", quote_ident(table));
    }
    format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_ident(table),
        columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", "),
        vec!["?"; columns.len()].join(", ")
    )
}

pub fn delete_row(table: &str, addr: &RowAddr) -> String {
    format!(
        "DELETE FROM {} WHERE {}",
        quote_ident(table),
        addr.match_clause()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn quotes_hostile_identifiers() {
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(
            quote_ident("x\"; DROP TABLE t; --"),
            "\"x\"\"; DROP TABLE t; --\""
        );
    }

    #[test]
    fn picks_an_unshadowed_rowid_alias() {
        assert_eq!(rowid_alias(&cols(&["a"])), Some("rowid"));
        assert_eq!(rowid_alias(&cols(&["ROWID", "a"])), Some("_rowid_"));
        assert_eq!(rowid_alias(&cols(&["rowid", "_rowid_", "oid"])), None);
    }

    #[test]
    fn escapes_like_wildcards() {
        assert_eq!(like_contains("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }

    #[test]
    fn builds_page_queries() {
        let c = cols(&["id", "name"]);
        assert_eq!(
            select_page("t", &c, &RowAddr::Rowid("rowid"), None, None),
            "SELECT rowid, \"id\", \"name\" FROM \"t\" ORDER BY rowid LIMIT ?1 OFFSET ?2"
        );
        assert_eq!(
            select_page(
                "t",
                &c,
                &RowAddr::Pk(cols(&["id"])),
                Some(Sort { column: "name", desc: true }),
                Some(Filter { column: None }),
            ),
            "SELECT \"id\", \"id\", \"name\" FROM \"t\" WHERE (\"id\" LIKE ?1 ESCAPE '\\' OR \"name\" LIKE ?1 ESCAPE '\\') ORDER BY \"name\" DESC, \"id\" LIMIT ?2 OFFSET ?3"
        );
        assert_eq!(
            count_rows(
                "t",
                &c,
                Some(Filter {
                    column: Some("name")
                })
            ),
            "SELECT count(*) FROM \"t\" WHERE (\"name\" LIKE ?1 ESCAPE '\\')"
        );
    }

    #[test]
    fn builds_mutations() {
        let pk = RowAddr::Pk(cols(&["a", "b"]));
        assert_eq!(
            update_row("t", &["x", "y"], &pk),
            "UPDATE \"t\" SET \"x\" = ?, \"y\" = ? WHERE \"a\" IS ? AND \"b\" IS ?"
        );
        assert_eq!(
            delete_row("t", &RowAddr::Rowid("oid")),
            "DELETE FROM \"t\" WHERE oid IS ?"
        );
        assert_eq!(
            insert_row("t", &["a", "b"]),
            "INSERT INTO \"t\" (\"a\", \"b\") VALUES (?, ?)"
        );
        assert_eq!(insert_row("t", &[]), "INSERT INTO \"t\" DEFAULT VALUES");
    }
}
