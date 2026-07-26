const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function nowIso() {
  return new Date().toISOString();
}

function normalizeMapping(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    name: row.name,
    whatsappGroupId: row.whatsapp_group_id,
    whatsappGroupName: row.whatsapp_group_name,
    signalGroupId: row.signal_group_id,
    signalGroupInternalId: row.signal_group_internal_id,
    signalGroupName: row.signal_group_name,
    syncWhatsappToSignal: Boolean(Number(row.sync_whatsapp_to_signal)),
    syncSignalToWhatsapp: Boolean(Number(row.sync_signal_to_whatsapp)),
    syncMedia: Boolean(Number(row.sync_media)),
    prependSender: Boolean(Number(row.prepend_sender)),
    active: Boolean(Number(row.active)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

class AppDatabase {
  static async create(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const databaseExists = fs.existsSync(databasePath);
    const database = new DatabaseSync(databasePath);

    if (!databaseExists) {
      fs.chmodSync(databasePath, 0o600);
    }

    return new AppDatabase(databasePath, database);
  }

  constructor(databasePath, database) {
    this.databasePath = databasePath;
    this.db = database;
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  get(sql, params = []) {
    return this.db.prepare(sql).get(...params) || null;
  }

  all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  initialize() {
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        whatsapp_group_id TEXT NOT NULL,
        whatsapp_group_name TEXT,
        signal_group_id TEXT NOT NULL,
        signal_group_internal_id TEXT NOT NULL,
        signal_group_name TEXT,
        sync_whatsapp_to_signal INTEGER NOT NULL DEFAULT 1,
        sync_signal_to_whatsapp INTEGER NOT NULL DEFAULT 1,
        sync_media INTEGER NOT NULL DEFAULT 1,
        prepend_sender INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (whatsapp_group_id, signal_group_internal_id)
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        provider TEXT,
        source_id TEXT,
        target_id TEXT,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_messages (
        fingerprint TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reply_links (
        mapping_id INTEGER NOT NULL,
        whatsapp_message_id TEXT NOT NULL,
        signal_message_timestamp TEXT NOT NULL,
        signal_author TEXT NOT NULL,
        signal_message_text TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (mapping_id, whatsapp_message_id)
      );

      CREATE TABLE IF NOT EXISTS delivery_tracking (
        fingerprint TEXT NOT NULL,
        mapping_id INTEGER NOT NULL,
        direction TEXT NOT NULL,
        part_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (fingerprint, mapping_id, direction, part_key),
        FOREIGN KEY (mapping_id) REFERENCES mappings (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pending_messages (
        fingerprint TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dead_letter_messages (
        fingerprint TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dead_lettered_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reply_links_created_at ON reply_links (created_at);
      CREATE INDEX IF NOT EXISTS idx_delivery_tracking_created_at ON delivery_tracking (created_at);
      CREATE INDEX IF NOT EXISTS idx_pending_messages_next_attempt ON pending_messages (next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_dead_letter_messages_created_at ON dead_letter_messages (dead_lettered_at);
    `));

    this.cleanup();
  }

  getUserByUsername(username) {
    return this.get('SELECT * FROM users WHERE username = ?', [username]);
  }

  deleteUsersExcept(username) {
    this.run('DELETE FROM users WHERE username <> ?', [username]);
  }

  upsertUser(username, passwordHash) {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO users (username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = excluded.password_hash,
         updated_at = excluded.updated_at`,
      [username, passwordHash, timestamp, timestamp]
    );
  }

  listMappings() {
    return this.all('SELECT * FROM mappings ORDER BY active DESC, name ASC, id DESC').map(normalizeMapping);
  }

  getMappingById(id) {
    return normalizeMapping(this.get('SELECT * FROM mappings WHERE id = ?', [id]));
  }

  getMappingsByWhatsappGroupId(whatsappGroupId) {
    return this.all(
      'SELECT * FROM mappings WHERE whatsapp_group_id = ? AND active = 1 AND sync_whatsapp_to_signal = 1 ORDER BY id ASC',
      [whatsappGroupId]
    ).map(normalizeMapping);
  }

  getMappingsBySignalInternalId(signalGroupInternalId) {
    return this.all(
      'SELECT * FROM mappings WHERE signal_group_internal_id = ? AND active = 1 AND sync_signal_to_whatsapp = 1 ORDER BY id ASC',
      [signalGroupInternalId]
    ).map(normalizeMapping);
  }

  createMapping(mapping) {
    const timestamp = nowIso();
    const result = this.run(
      `INSERT INTO mappings (
        name,
        whatsapp_group_id,
        whatsapp_group_name,
        signal_group_id,
        signal_group_internal_id,
        signal_group_name,
        sync_whatsapp_to_signal,
        sync_signal_to_whatsapp,
        sync_media,
        prepend_sender,
        active,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mapping.name,
        mapping.whatsappGroupId,
        mapping.whatsappGroupName || null,
        mapping.signalGroupId,
        mapping.signalGroupInternalId,
        mapping.signalGroupName || null,
        mapping.syncWhatsappToSignal ? 1 : 0,
        mapping.syncSignalToWhatsapp ? 1 : 0,
        mapping.syncMedia ? 1 : 0,
        mapping.prependSender ? 1 : 0,
        mapping.active ? 1 : 0,
        timestamp,
        timestamp
      ]
    );

    return this.getMappingById(Number(result.lastInsertRowid));
  }

  updateMapping(id, mapping) {
    const existing = this.getMappingById(id);
    if (!existing) {
      return null;
    }

    const next = { ...existing, ...mapping };
    this.run(
      `UPDATE mappings
       SET name = ?,
           whatsapp_group_id = ?,
           whatsapp_group_name = ?,
           signal_group_id = ?,
           signal_group_internal_id = ?,
           signal_group_name = ?,
           sync_whatsapp_to_signal = ?,
           sync_signal_to_whatsapp = ?,
           sync_media = ?,
           prepend_sender = ?,
           active = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        next.name,
        next.whatsappGroupId,
        next.whatsappGroupName || null,
        next.signalGroupId,
        next.signalGroupInternalId,
        next.signalGroupName || null,
        next.syncWhatsappToSignal ? 1 : 0,
        next.syncSignalToWhatsapp ? 1 : 0,
        next.syncMedia ? 1 : 0,
        next.prependSender ? 1 : 0,
        next.active ? 1 : 0,
        nowIso(),
        id
      ]
    );

    return this.getMappingById(id);
  }

  deleteMapping(id) {
    this.transaction(() => {
      this.run('DELETE FROM reply_links WHERE mapping_id = ?', [id]);
      this.run('DELETE FROM delivery_tracking WHERE mapping_id = ?', [id]);
      this.run('DELETE FROM mappings WHERE id = ?', [id]);
    });
    return true;
  }

  saveReplyLink({ mappingId, whatsappMessageId, signalMessageTimestamp, signalAuthor, signalMessageText }) {
    if (!whatsappMessageId || !signalMessageTimestamp || !signalAuthor) {
      return;
    }

    this.run(
      `INSERT OR REPLACE INTO reply_links (
        mapping_id,
        whatsapp_message_id,
        signal_message_timestamp,
        signal_author,
        signal_message_text,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [mappingId, whatsappMessageId, signalMessageTimestamp, signalAuthor, signalMessageText || null, nowIso()]
    );
  }

  getReplyLink(mappingId, whatsappMessageId) {
    const row = this.get(
      'SELECT * FROM reply_links WHERE mapping_id = ? AND whatsapp_message_id = ?',
      [mappingId, whatsappMessageId]
    );

    if (!row) {
      return null;
    }

    return {
      mappingId: Number(row.mapping_id),
      whatsappMessageId: row.whatsapp_message_id,
      signalMessageTimestamp: row.signal_message_timestamp,
      signalAuthor: row.signal_author,
      signalMessageText: row.signal_message_text || ''
    };
  }

  getReplyLinkBySignalMessage(mappingId, signalMessageTimestamp) {
    const row = this.get(
      `SELECT * FROM reply_links
       WHERE mapping_id = ? AND signal_message_timestamp = ?
       ORDER BY created_at DESC LIMIT 1`,
      [mappingId, signalMessageTimestamp]
    );

    if (!row) {
      return null;
    }

    return {
      mappingId: Number(row.mapping_id),
      whatsappMessageId: row.whatsapp_message_id,
      signalMessageTimestamp: row.signal_message_timestamp,
      signalAuthor: row.signal_author,
      signalMessageText: row.signal_message_text || ''
    };
  }

  addActivity(entry) {
    this.transaction(() => {
      this.run(
        `INSERT INTO activity_logs (
          level,
          event_type,
          provider,
          source_id,
          target_id,
          message,
          details_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.level,
          entry.eventType,
          entry.provider || null,
          entry.sourceId || null,
          entry.targetId || null,
          entry.message,
          entry.details ? JSON.stringify(entry.details) : null,
          nowIso()
        ]
      );
      this.run(
        `DELETE FROM activity_logs
         WHERE id NOT IN (SELECT id FROM activity_logs ORDER BY id DESC LIMIT ?)`,
        [500]
      );
    });
  }

  listActivity(limit = 100) {
    return this.all('SELECT * FROM activity_logs ORDER BY id DESC LIMIT ?', [limit]).map((row) => ({
      id: Number(row.id),
      level: row.level,
      eventType: row.event_type,
      provider: row.provider,
      sourceId: row.source_id,
      targetId: row.target_id,
      message: row.message,
      details: row.details_json ? JSON.parse(row.details_json) : null,
      createdAt: row.created_at
    }));
  }

  hasProcessedFingerprint(fingerprint) {
    return Boolean(this.get('SELECT fingerprint FROM processed_messages WHERE fingerprint = ?', [fingerprint]));
  }

  markProcessedFingerprint(fingerprint, provider) {
    this.run(
      'INSERT OR IGNORE INTO processed_messages (fingerprint, provider, created_at) VALUES (?, ?, ?)',
      [fingerprint, provider, nowIso()]
    );
  }

  isDeliveryComplete(fingerprint, mappingId, direction, partKey) {
    return Boolean(this.get(
      `SELECT 1 FROM delivery_tracking
       WHERE fingerprint = ? AND mapping_id = ? AND direction = ? AND part_key = ?`,
      [fingerprint, mappingId, direction, partKey]
    ));
  }

  markDeliveryComplete(fingerprint, mappingId, direction, partKey) {
    const result = this.run(
      `INSERT OR IGNORE INTO delivery_tracking (
        fingerprint, mapping_id, direction, part_key, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [fingerprint, mappingId, direction, partKey, nowIso()]
    );
    return result.changes > 0;
  }

  enqueuePendingMessage(event, maxQueueBytes = Number.MAX_SAFE_INTEGER) {
    const serialized = JSON.stringify({
      ...event,
      attachments: event.attachments.map((attachment) => ({
        ...attachment,
        buffer: attachment.buffer.toString('base64')
      }))
    });
    const eventBytes = Buffer.byteLength(serialized, 'utf8');
    const timestamp = nowIso();
    return this.transaction(() => {
      const duplicate = this.get(
        `SELECT 1 FROM pending_messages WHERE fingerprint = ?
         UNION ALL
         SELECT 1 FROM dead_letter_messages WHERE fingerprint = ?
         LIMIT 1`,
        [event.fingerprint, event.fingerprint]
      );
      if (duplicate) return { status: 'duplicate', eventBytes };

      const queueBytes = Number(this.get(
        'SELECT COALESCE(SUM(length(CAST(event_json AS BLOB))), 0) AS bytes FROM pending_messages'
      )?.bytes || 0);
      if (eventBytes > maxQueueBytes || queueBytes > maxQueueBytes - eventBytes) {
        return { status: 'queue_full', eventBytes, queueBytes };
      }

      this.run(
        `INSERT INTO pending_messages (
          fingerprint, provider, event_json, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [event.fingerprint, event.provider, serialized, timestamp, timestamp]
      );
      return { status: 'enqueued', eventBytes, queueBytes: queueBytes + eventBytes };
    });
  }

  listPendingMessages(limit = 20) {
    return this.all(
      `SELECT * FROM pending_messages
       WHERE next_attempt_at <= ?
       ORDER BY created_at ASC LIMIT ?`,
      [nowIso(), limit]
    ).map((row) => {
      const event = JSON.parse(row.event_json);
      event.attachments = event.attachments.map((attachment) => ({
        ...attachment,
        buffer: Buffer.from(attachment.buffer, 'base64')
      }));
      return { event, attempts: Number(row.attempts) };
    });
  }

  recordPendingFailure(fingerprint, attempts, error, maxAttempts) {
    const nextAttempts = attempts + 1;
    if (nextAttempts >= maxAttempts) {
      return this.deadLetterPending(fingerprint, nextAttempts, error, 'attempts_exhausted');
    }

    const delayMs = Math.min(5000 * (2 ** attempts), 5 * 60 * 1000);
    const nextAttempt = new Date(Date.now() + delayMs).toISOString();
    this.run(
      `UPDATE pending_messages
       SET attempts = ?, next_attempt_at = ?, last_error = ?
       WHERE fingerprint = ?`,
      [nextAttempts, nextAttempt, String(error || '').slice(0, 1000), fingerprint]
    );
    return { status: 'retry', attempts: nextAttempts, nextAttemptAt: nextAttempt };
  }

  deadLetterPending(fingerprint, attempts, error, reason) {
    return this.transaction(() => {
      const pending = this.get(
        'SELECT fingerprint, provider, created_at FROM pending_messages WHERE fingerprint = ?',
        [fingerprint]
      );
      if (!pending) return { status: 'not_found' };

      this.run(
        `INSERT OR REPLACE INTO dead_letter_messages (
          fingerprint, provider, attempts, last_error, reason, created_at, dead_lettered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          pending.fingerprint,
          pending.provider,
          attempts,
          String(error || '').slice(0, 1000),
          reason,
          pending.created_at,
          nowIso()
        ]
      );
      this.run('DELETE FROM pending_messages WHERE fingerprint = ?', [fingerprint]);
      return { status: 'dead_letter', fingerprint, provider: pending.provider, attempts, reason };
    });
  }

  deadLetterExpiredPending(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const expired = this.all(
      'SELECT fingerprint, attempts, last_error FROM pending_messages WHERE created_at <= ?',
      [cutoff]
    );
    return expired.map((pending) => this.deadLetterPending(
      pending.fingerprint,
      Number(pending.attempts),
      pending.last_error || 'Pending message exceeded maximum age',
      'max_age_exceeded'
    ));
  }

  deletePendingMessage(fingerprint) {
    this.run('DELETE FROM pending_messages WHERE fingerprint = ?', [fingerprint]);
  }

  countPendingMessages() {
    return Number(this.get('SELECT COUNT(*) AS count FROM pending_messages')?.count || 0);
  }

  listDeadLetters(limit = 100) {
    return this.all(
      'SELECT * FROM dead_letter_messages ORDER BY dead_lettered_at DESC LIMIT ?',
      [limit]
    ).map((row) => ({
      fingerprint: row.fingerprint,
      provider: row.provider,
      attempts: Number(row.attempts),
      lastError: row.last_error,
      reason: row.reason,
      createdAt: row.created_at,
      deadLetteredAt: row.dead_lettered_at
    }));
  }

  cleanupProcessedMessages(maxAgeHours = 24) {
    const cutoff = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000)).toISOString();
    this.run('DELETE FROM processed_messages WHERE created_at < ?', [cutoff]);
  }

  cleanupReplyLinks(maxAgeDays = 30) {
    const cutoff = new Date(Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)).toISOString();
    this.run('DELETE FROM reply_links WHERE created_at < ?', [cutoff]);
  }

  cleanupDeliveries(maxAgeDays = 30) {
    const cutoff = new Date(Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)).toISOString();
    this.run('DELETE FROM delivery_tracking WHERE created_at < ?', [cutoff]);
  }

  cleanupDeadLetters(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    this.run('DELETE FROM dead_letter_messages WHERE dead_lettered_at < ?', [cutoff]);
  }

  cleanup({
    processedMaxAgeHours = 24,
    replyLinkMaxAgeDays = 30,
    deliveryMaxAgeDays = 30,
    deadLetterMaxAgeMs = 7 * 24 * 60 * 60 * 1000
  } = {}) {
    this.transaction(() => {
      this.cleanupProcessedMessages(processedMaxAgeHours);
      this.cleanupReplyLinks(replyLinkMaxAgeDays);
      this.cleanupDeliveries(deliveryMaxAgeDays);
      this.cleanupDeadLetters(deadLetterMaxAgeMs);
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = AppDatabase;
