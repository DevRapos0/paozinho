const { Pool } = require('pg');

// Usa DATABASE_URL se disponível (Railway Postgres), senão SQLite local
const USE_PG = !!process.env.DATABASE_URL;

let db, Clientes, Fornadas, Envios, Config;

if (USE_PG) {
  // ─── PostgreSQL (produção no Railway) ──────────────────────────────────
  console.log('[DB] Usando PostgreSQL');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Inicializa tabelas
  async function initDB() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id          SERIAL PRIMARY KEY,
        nome        TEXT    NOT NULL DEFAULT 'Cliente',
        numero      TEXT    NOT NULL UNIQUE,
        ativo       INTEGER NOT NULL DEFAULT 1,
        origem      TEXT    NOT NULL DEFAULT 'manual',
        criado_em   TEXT    NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
        updated_em  TEXT    NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );
      CREATE TABLE IF NOT EXISTS fornadas (
        id           SERIAL PRIMARY KEY,
        mensagem     TEXT    NOT NULL,
        total_envios INTEGER NOT NULL DEFAULT 0,
        ok_envios    INTEGER NOT NULL DEFAULT 0,
        erro_envios  INTEGER NOT NULL DEFAULT 0,
        origem       TEXT    NOT NULL DEFAULT 'manual',
        criado_em    TEXT    NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );
      CREATE TABLE IF NOT EXISTS envios (
        id           SERIAL PRIMARY KEY,
        fornada_id   INTEGER NOT NULL,
        cliente_id   INTEGER NOT NULL,
        numero       TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'pendente',
        erro_msg     TEXT,
        message_id   TEXT,
        enviado_em   TEXT    DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      );
      CREATE TABLE IF NOT EXISTS config (
        chave  TEXT PRIMARY KEY,
        valor  TEXT NOT NULL
      );
      INSERT INTO config VALUES
        ('mensagem_padrao', '🍞 *Saiu fornada quentinha!*\n\nOlá {nome}! O pão acabou de sair do forno aqui na {padaria}. Venha aproveitar quentinho! 🔥\n\n_Para parar de receber: responda "parar alertas"_'),
        ('padaria_nome', 'Padaria Aconchego')
      ON CONFLICT (chave) DO NOTHING;
    `);
    console.log('[DB] Tabelas PostgreSQL prontas!');
  }

  initDB().catch(err => console.error('[DB] Erro ao iniciar:', err.message));

  // Helper para queries
  const q = (text, params) => pool.query(text, params);

  Clientes = {
    listar:          () => q('SELECT * FROM clientes ORDER BY nome ASC').then(r => r.rows),
    listarAtivos:    () => q('SELECT * FROM clientes WHERE ativo = 1 ORDER BY nome ASC').then(r => r.rows),
    buscarPorNumero: (num) => q('SELECT * FROM clientes WHERE numero = $1', [num]).then(r => r.rows[0]),
    inserir:         ({ nome, numero, origem }) => q('INSERT INTO clientes (nome, numero, origem) VALUES ($1, $2, $3) RETURNING *', [nome, numero, origem]).then(r => r.rows[0]),
    atualizar:       ({ id, nome, ativo }) => q('UPDATE clientes SET nome = COALESCE($1, nome), ativo = COALESCE($2, ativo), updated_em = to_char(now(),\'YYYY-MM-DD HH24:MI:SS\') WHERE id = $3', [nome, ativo, id]),
    toggleAtivo:     (id) => q('UPDATE clientes SET ativo = CASE WHEN ativo = 1 THEN 0 ELSE 1 END WHERE id = $1', [id]),
    desativarPorNumero: (num) => q('UPDATE clientes SET ativo = 0 WHERE numero = $1', [num]),
    deletar:         (id) => q('DELETE FROM clientes WHERE id = $1', [id]),
    total:           () => q('SELECT COUNT(*) as n FROM clientes WHERE ativo = 1').then(r => ({ n: parseInt(r.rows[0].n) })),
  };

  Fornadas = {
    inserir: async ({ mensagem, origem }) => {
      const r = await q('INSERT INTO fornadas (mensagem, origem) VALUES ($1, $2) RETURNING id', [mensagem, origem]);
      return { lastInsertRowid: r.rows[0].id };
    },
    atualizarContadores: ({ id, total, ok, erros }) => q('UPDATE fornadas SET total_envios=$1, ok_envios=$2, erro_envios=$3 WHERE id=$4', [total, ok, erros, id]),
    listar:    () => q('SELECT * FROM fornadas ORDER BY criado_em DESC LIMIT 50').then(r => r.rows),
    totalHoje: () => q("SELECT COUNT(*) as n FROM fornadas WHERE criado_em::date = CURRENT_DATE").then(r => ({ n: parseInt(r.rows[0].n) })),
  };

  Envios = {
    inserir: async ({ fornada_id, cliente_id, numero }) => {
      const r = await q('INSERT INTO envios (fornada_id, cliente_id, numero) VALUES ($1, $2, $3) RETURNING id', [fornada_id, cliente_id, numero]);
      return { lastInsertRowid: r.rows[0].id };
    },
    atualizarStatus: ({ id, status, erro_msg, message_id }) => q('UPDATE envios SET status=$1, erro_msg=$2, message_id=$3 WHERE id=$4', [status, erro_msg, message_id, id]),
    porFornada: (fornada_id) => q('SELECT e.*, c.nome FROM envios e JOIN clientes c ON c.id = e.cliente_id WHERE e.fornada_id = $1 ORDER BY e.id ASC', [fornada_id]).then(r => r.rows),
    totalEnviadosHoje: () => q("SELECT COUNT(*) as n FROM envios WHERE status='ok' AND enviado_em::date = CURRENT_DATE").then(r => ({ n: parseInt(r.rows[0].n) })),
  };

  Config = {
    getValor: async (chave) => {
      const r = await q('SELECT valor FROM config WHERE chave = $1', [chave]);
      return r.rows[0]?.valor || null;
    },
    setValor: (chave, valor) => q('INSERT INTO config VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = $2', [chave, valor]),
  };

  db = pool;

} else {
  // ─── SQLite (desenvolvimento local) ───────────────────────────────────
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');

  const DB_PATH = path.join(process.cwd(), 'paocalert.db');
  console.log('[DB] Usando SQLite em: ' + DB_PATH);
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL DEFAULT 'Cliente',
      numero TEXT NOT NULL UNIQUE, ativo INTEGER NOT NULL DEFAULT 1,
      origem TEXT NOT NULL DEFAULT 'manual',
      criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS fornadas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mensagem TEXT NOT NULL,
      total_envios INTEGER NOT NULL DEFAULT 0, ok_envios INTEGER NOT NULL DEFAULT 0,
      erro_envios INTEGER NOT NULL DEFAULT 0, origem TEXT NOT NULL DEFAULT 'manual',
      criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS envios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fornada_id INTEGER NOT NULL,
      cliente_id INTEGER NOT NULL, numero TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente', erro_msg TEXT, message_id TEXT,
      enviado_em TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    INSERT OR IGNORE INTO config VALUES
      ('mensagem_padrao','🍞 *Saiu fornada quentinha!*\n\nOlá {nome}! O pão acabou de sair do forno aqui na {padaria}. Venha aproveitar quentinho! 🔥\n\n_Para parar de receber: responda "parar alertas"_'),
      ('padaria_nome','Padaria Aconchego');
  `);

  const wrap = (stmt) => ({
    all: (...a) => stmt.all(...a),
    get: (...a) => stmt.get(...a),
    run: (...a) => stmt.run(...a),
  });

  Clientes = {
    listar:          () => sqlite.prepare('SELECT * FROM clientes ORDER BY nome ASC').all(),
    listarAtivos:    () => sqlite.prepare('SELECT * FROM clientes WHERE ativo = 1 ORDER BY nome ASC').all(),
    buscarPorNumero: (num) => sqlite.prepare('SELECT * FROM clientes WHERE numero = ?').get(num),
    inserir:         ({ nome, numero, origem }) => sqlite.prepare('INSERT INTO clientes (nome,numero,origem) VALUES (?,?,?)').run(nome, numero, origem),
    atualizar:       ({ id, nome, ativo }) => sqlite.prepare('UPDATE clientes SET nome=COALESCE(?,nome), ativo=COALESCE(?,ativo) WHERE id=?').run(nome, ativo, id),
    toggleAtivo:     (id) => sqlite.prepare('UPDATE clientes SET ativo=CASE WHEN ativo=1 THEN 0 ELSE 1 END WHERE id=?').run(id),
    desativarPorNumero: (num) => sqlite.prepare('UPDATE clientes SET ativo=0 WHERE numero=?').run(num),
    deletar:         (id) => sqlite.prepare('DELETE FROM clientes WHERE id=?').run(id),
    total:           () => sqlite.prepare('SELECT COUNT(*) as n FROM clientes WHERE ativo=1').get(),
  };

  Fornadas = {
    inserir:             ({ mensagem, origem }) => sqlite.prepare('INSERT INTO fornadas (mensagem,origem) VALUES (?,?)').run(mensagem, origem),
    atualizarContadores: ({ id, total, ok, erros }) => sqlite.prepare('UPDATE fornadas SET total_envios=?,ok_envios=?,erro_envios=? WHERE id=?').run(total, ok, erros, id),
    listar:              () => sqlite.prepare('SELECT * FROM fornadas ORDER BY criado_em DESC LIMIT 50').all(),
    totalHoje:           () => sqlite.prepare("SELECT COUNT(*) as n FROM fornadas WHERE date(criado_em)=date('now','localtime')").get(),
  };

  Envios = {
    inserir:            ({ fornada_id, cliente_id, numero }) => sqlite.prepare('INSERT INTO envios (fornada_id,cliente_id,numero) VALUES (?,?,?)').run(fornada_id, cliente_id, numero),
    atualizarStatus:    ({ id, status, erro_msg, message_id }) => sqlite.prepare('UPDATE envios SET status=?,erro_msg=?,message_id=? WHERE id=?').run(status, erro_msg, message_id, id),
    porFornada:         (fornada_id) => sqlite.prepare('SELECT e.*,c.nome FROM envios e JOIN clientes c ON c.id=e.cliente_id WHERE e.fornada_id=? ORDER BY e.id ASC').all(fornada_id),
    totalEnviadosHoje:  () => sqlite.prepare("SELECT COUNT(*) as n FROM envios WHERE status='ok' AND date(enviado_em)=date('now','localtime')").get(),
  };

  Config = {
    getValor: (chave) => { const r = sqlite.prepare('SELECT valor FROM config WHERE chave=?').get(chave); return r?.valor || null; },
    setValor: (chave, valor) => sqlite.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run(chave, valor),
  };

  db = sqlite;
}

module.exports = { db, Clientes, Fornadas, Envios, Config, USE_PG };
