'use strict';

const mysql2 = require('mysql2/promise');

let _pool = null;

/**
 * Lazy-init MySQL pool untuk IAM DB (u294320793_nexamain).
 * Pool ini TERPISAH dari pool CRM existing di nexa-os.
 */
function getPool() {
  if (_pool) return _pool;

  _pool = mysql2.createPool({
    host:              process.env.IAM_DB_HOST     || 'srv1412.hstgr.io',
    port:    Number(   process.env.IAM_DB_PORT)    || 3306,
    user:              process.env.IAM_DB_USER,
    password:          process.env.IAM_DB_PASSWORD,
    database:          process.env.IAM_DB_NAME     || 'u294320793_nexamain',
    waitForConnections: true,
    connectionLimit:   10,
    queueLimit:        0,
    charset:           'utf8mb4',
    timezone:          '+00:00',
  });

  console.log('[IAM DB] MySQL pool initialized →', process.env.IAM_DB_NAME);
  return _pool;
}

module.exports = { getPool };

