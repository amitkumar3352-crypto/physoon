importScripts('https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/sql-wasm.js');
const SQLReady = initSqlJs({ locateFile: f => 'https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/' + f });
SQLReady.then(() => self.postMessage({ type: 'ready' }))
  .catch(err => self.postMessage({ type: 'boot-error', error: (err && err.message) ? err.message : String(err) }));

function quoteIdent(name){ return '"' + String(name).replace(/"/g, '""') + '"'; }

function splitStatements(sql){
  const stmts = []; let cur = ''; let inS = false, inD = false, inComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1];
    if (inComment) { cur += c; if (c === '\n') inComment = false; continue; }
    if (!inS && !inD && c === '-' && n === '-') { inComment = true; cur += c; continue; }
    if (!inD && c === "'") { inS = !inS; cur += c; continue; }
    if (!inS && c === '"') { inD = !inD; cur += c; continue; }
    if (!inS && !inD && c === ';') { if (cur.trim()) stmts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

function describeStatement(stmt, rowsModified){
  let m;
  if ((m = stmt.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/i))) return "Table '" + m[1] + "' created.";
  if (/^\s*INSERT\s+INTO/i.test(stmt)) return rowsModified + ' row(s) inserted.';
  if (/^\s*UPDATE\s/i.test(stmt)) return rowsModified + ' row(s) updated.';
  if (/^\s*DELETE\s+FROM/i.test(stmt)) return rowsModified + ' row(s) deleted.';
  if ((m = stmt.match(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)/i))) return "Table '" + m[1] + "' dropped.";
  if ((m = stmt.match(/^\s*ALTER\s+TABLE\s+["'`]?(\w+)/i))) return "Table '" + m[1] + "' altered.";
  return 'Statement executed.' + (rowsModified ? ' (' + rowsModified + ' row(s) affected)' : '');
}

function getSchema(db){
  const tables = [];
  try {
    const t = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    if (t.length) {
      for (const row of t[0].values) {
        const tname = row[0];
        const colsRes = db.exec('PRAGMA table_info(' + quoteIdent(tname) + ')');
        const columns = colsRes.length ? colsRes[0].values.map(v => ({ name: v[1], type: v[2] || '', primaryKey: !!v[5] })) : [];
        const countRes = db.exec('SELECT COUNT(*) FROM ' + quoteIdent(tname));
        const rowCount = countRes.length ? countRes[0].values[0][0] : 0;
        tables.push({ name: tname, columns, rowCount });
      }
    }
  } catch (e) { /* schema is best-effort */ }
  return tables;
}

self.onmessage = async function(e){
  if (e.data.type !== 'run') return;
  const SQL = await SQLReady;
  const db = new SQL.Database();
  const stmts = splitStatements(e.data.code);
  const results = []; let errorMsg = null;
  for (const stmt of stmts) {
    try {
      const out = db.exec(stmt);
      if (out.length && out[0].columns) {
        const cols = out[0].columns;
        const rows = out[0].values.map(v => { const o = {}; cols.forEach((c, i) => o[c] = v[i]); return o; });
        results.push({ type: 'rows', columns: cols, rows });
      } else {
        results.push({ type: 'ok', message: describeStatement(stmt, db.getRowsModified()) });
      }
    } catch (err) { errorMsg = (err && err.message) ? err.message : String(err); break; }
  }
  const schema = getSchema(db);
  db.close();
  self.postMessage({ type: 'done', results, error: errorMsg, schema });
};
