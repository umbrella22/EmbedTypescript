//! Apply pinned unified diffs with exact line positions and context, without fuzz.
pub fn apply(source: &str, patch: &str) -> Result<String, String> {
    let source_lines: Vec<_> = source.split_inclusive('\n').collect();
    let mut lines = patch.split_inclusive('\n').peekable();
    if lines.next() != Some("--- a/quickjs.c\n") || lines.next() != Some("+++ b/quickjs.c\n") {
        return Err("patch must target quickjs.c".into());
    }
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    let mut written = 0;
    let mut hunks = 0;
    while let Some(header) = lines.next() {
        let parts: Vec<_> = header.split_whitespace().collect();
        if parts.len() < 4 || parts[0] != "@@" || parts[3] != "@@" {
            return Err("invalid hunk header".into());
        }
        let (old_start, old_count) = range(parts[1], '-')?;
        let (new_start, new_count) = range(parts[2], '+')?;
        let start = old_start.checked_sub(1).ok_or("invalid source position")?;
        if start < cursor || start > source_lines.len() {
            return Err("hunk source position does not match".into());
        }
        for line in &source_lines[cursor..start] {
            output.push_str(line);
            written += 1;
        }
        cursor = start;
        if new_start.checked_sub(1) != Some(written) {
            return Err("hunk output position does not match".into());
        }
        let mut consumed = 0;
        let mut added = 0;
        while lines.peek().is_some_and(|line| !line.starts_with("@@ ")) {
            let line = lines.next().unwrap();
            let (kind, text) = line.split_at(1);
            if !text.ends_with('\n') || !matches!(kind, " " | "+" | "-") {
                return Err("invalid patch line".into());
            }
            if kind != "+" {
                if source_lines.get(cursor).copied() != Some(text) {
                    return Err(format!(
                        "patch context mismatch at source line {}",
                        cursor + 1
                    ));
                }
                cursor += 1;
                consumed += 1;
            }
            if kind != "-" {
                output.push_str(text);
                written += 1;
                added += 1;
            }
        }
        if consumed != old_count || added != new_count {
            return Err("hunk line counts do not match".into());
        }
        hunks += 1;
    }
    if hunks == 0 {
        return Err("patch has no hunks".into());
    }
    for line in &source_lines[cursor..] {
        output.push_str(line);
    }
    Ok(output)
}

fn range(text: &str, prefix: char) -> Result<(usize, usize), String> {
    let range = text.strip_prefix(prefix).ok_or("invalid hunk range")?;
    let (start, count) = range.split_once(',').unwrap_or((range, "1"));
    Ok((
        start.parse().map_err(|_| "invalid hunk start")?,
        count.parse().map_err(|_| "invalid hunk count")?,
    ))
}
