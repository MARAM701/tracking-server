const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

// ─── Environment check ───────────────────────────────────────────────
const required = ["DB_USER", "DB_HOST", "DB_NAME", "DB_PASS", "DB_PORT"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error("Missing env vars: " + missing.join(", "));
}

// ─── Config ──────────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  LOG_PATH: path.join(__dirname, 'logs'),
  MAX_REQUEST_SIZE: '1mb',
  CORS_ORIGINS: ['https://radiant-concha-b54632.netlify.app'],
  RATE_LIMIT: { windowMs: 15 * 60 * 1000, max: 100 },
  ADMIN_SECRET: process.env.ADMIN_SECRET || null,
  DB: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS,
    port: Number(process.env.DB_PORT),
    ssl: { rejectUnauthorized: false }
  }
};

console.log("DB CONFIG (no password):", {
  host: CONFIG.DB.host,
  port: CONFIG.DB.port,
  database: CONFIG.DB.database,
  user: CONFIG.DB.user,
  ssl: !!CONFIG.DB.ssl
});

// ─── Express setup ───────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: CONFIG.CORS_ORIGINS,
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']
}));

app.use(express.json({ limit: CONFIG.MAX_REQUEST_SIZE }));
app.use(express.static('public'));

const limiter = rateLimit(CONFIG.RATE_LIMIT);
app.use('/track', limiter);

app.use(morgan(':method :url :status :response-time ms'));

// Ensure logs directory exists
fs.mkdir(CONFIG.LOG_PATH, { recursive: true }).catch(() => {});

// ─── PostgreSQL pool ─────────────────────────────────────────────────
const pool = new Pool(CONFIG.DB);

// ─── Valid event types (first-version taxonomy) ──────────────────────
const VALID_EVENT_TYPES = [
  'consent_agree',
  'consent_disagree',
  'instructions_next',
  'location_icon_clicked',
  'permission_dialog_shown',
  'permission_decision',
  'book_now_clicked',
  'survey_link_clicked',
  'manual_pickup_entered'
];

// ─── Helpers ─────────────────────────────────────────────────────────

function toNullableText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toNullableTimestamp(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// FIX 4: Safe boolean parser — rejects ambiguous values like Boolean("false") → true
function toStrictBoolean(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

// ─── Error logging ───────────────────────────────────────────────────
// NOTE (FIX 6): These file logs live on Render's ephemeral filesystem.
// They will be lost on redeploy/restart. Do not treat them as durable
// long-term storage. They are useful only for temporary debugging.
// All errors are also sent to stdout so Render's log viewer captures them.

async function logError(error, requestData = null, additionalInfo = {}) {
  const errorLog = {
    timestamp: new Date().toISOString(),
    error: error.message,
    stack: error.stack,
    requestData,
    ...additionalInfo
  };

  // Always log to stdout so Render's log viewer captures it
  console.error('LOGGED_ERROR:', JSON.stringify(errorLog));

  const logFile = path.join(CONFIG.LOG_PATH, `error_${new Date().toISOString().split('T')[0]}.log`);
  try {
    await fs.appendFile(logFile, JSON.stringify(errorLog) + '\n');
  } catch (err) {
    console.error('Error writing to log file:', err);
  }
}

// ─── Custom error class for validation ───────────────────────────────
// FIX 2: Distinguishes validation errors (400) from server/db errors (500)

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ─── Payload validation per event type ───────────────────────────────

function validatePayload(eventType, rawPayload) {
  const payload = rawPayload || {};

  switch (eventType) {

    case 'consent_agree':
    case 'consent_disagree':
      return {};

    case 'instructions_next':
      return {};

    case 'location_icon_clicked':
      return {};

    case 'permission_dialog_shown': {
      const cleaned = {};
      if (payload.dialog_variant !== undefined) {
        cleaned.dialog_variant = String(payload.dialog_variant).trim();
      }
      return cleaned;
    }

    case 'permission_decision': {
      const errors = [];
      const decision = toNullableText(payload.decision);
      if (!decision) {
        errors.push('permission_decision event requires payload.decision');
      } else {
        const validDecisions = ['allow', 'block', 'dismiss'];
        if (!validDecisions.includes(decision)) {
          errors.push('payload.decision must be allow, block, or dismiss');
        }
      }
      if (errors.length) throw new ValidationError(errors.join(', '));

      const cleaned = { decision };
      if (payload.dialog_variant !== undefined) {
        cleaned.dialog_variant = String(payload.dialog_variant).trim();
      }
      return cleaned;
    }

    case 'book_now_clicked': {
      // FIX 4: Safe boolean — rejects ambiguous values
      const cleaned = {};
      if (payload.button_enabled !== undefined) {
        const parsed = toStrictBoolean(payload.button_enabled);
        if (parsed === null) {
          throw new ValidationError(
            'payload.button_enabled must be true, false, "true", or "false"'
          );
        }
        cleaned.button_enabled = parsed;
      }
      return cleaned;
    }

    case 'survey_link_clicked': {
      const cleaned = {};
      if (payload.survey_url !== undefined) {
        cleaned.survey_url = String(payload.survey_url).trim();
      }
      return cleaned;
    }

    case 'manual_pickup_entered': {
      const cleaned = {};
      const entryMethod = toNullableText(payload.entry_method);
      if (entryMethod) {
        const validMethods = ['autocomplete', 'typed'];
        if (!validMethods.includes(entryMethod)) {
          throw new ValidationError(
            'payload.entry_method must be "autocomplete" or "typed"'
          );
        }
        cleaned.entry_method = entryMethod;
      }
      if (payload.pickup_present !== undefined) {
        const parsed = toStrictBoolean(payload.pickup_present);
        if (parsed === null) {
          throw new ValidationError(
            'payload.pickup_present must be true, false, "true", or "false"'
          );
        }
        cleaned.pickup_present = parsed;
      }
      return cleaned;
    }

    default:
      return {};
  }
}

// ─── Main validation function ────────────────────────────────────────

function validateEventData(data) {
  const errors = [];

  // FIX 3: Clean required IDs with toNullableText — rejects whitespace-only
  // values like "   " and trims valid values for clean joins in analysis
  const sessionId        = toNullableText(data.session_id);
  const experimentRunId  = toNullableText(data.experiment_run_id);
  const userId           = toNullableText(data.user_id);

  if (!sessionId)        errors.push('session_id is required');
  if (!experimentRunId)  errors.push('experiment_run_id is required');
  if (!userId)           errors.push('user_id is required');

  // FIX 5: Normalize event_type — trim before whitelist check so
  // " permission_decision " doesn't get rejected unnecessarily
  const eventType = toNullableText(data.event_type);
  if (!eventType) {
    errors.push('event_type is required');
  } else if (!VALID_EVENT_TYPES.includes(eventType)) {
    errors.push(`event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`);
  }

  const eventTimestamp = toNullableTimestamp(data.event_timestamp);
  if (!eventTimestamp) {
    errors.push('event_timestamp is required and must be a valid ISO timestamp');
  }

  if (errors.length) {
    throw new ValidationError(errors.join(', '));
  }

  const cleanedPayload = validatePayload(eventType, data.payload);

  return {
    session_id:         sessionId,
    experiment_run_id:  experimentRunId,
    user_id:            userId,
    event_type:         eventType,
    event_timestamp:    eventTimestamp,
    payload:            cleanedPayload,

    browser:            toNullableText(data.browser),
    operating_system:   toNullableText(data.operating_system),
    device_type:        toNullableText(data.device_type),
    country:            toNullableText(data.country)
  };
}

// ─── Routes ──────────────────────────────────────────────────────────

// FIX 1: /data is now protected by ADMIN_SECRET
// Set ADMIN_SECRET in your Render environment variables, then call:
//   GET /data  with header  Authorization: Bearer <your-secret>
// If ADMIN_SECRET is not set, the endpoint is fully disabled.
app.get('/data', async (req, res) => {
  if (!CONFIG.ADMIN_SECRET) {
    return res.status(403).json({
      success: false,
      error: 'Data endpoint is disabled. Set ADMIN_SECRET to enable it.'
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Missing or malformed Authorization header. Use: Bearer <secret>'
    });
  }

  const providedSecret = authHeader.slice(7);
  if (providedSecret !== CONFIG.ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'Invalid secret' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM public.user_events ORDER BY created_at DESC'
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    await logError(error, null, { endpoint: '/data' });
    res.status(500).json({ success: false, error: 'Failed to read data from database' });
  }
});

// POST /track — log a single event
app.post('/track', async (req, res) => {
  // FIX 2: Validation errors → 400, database/server errors → 500
  let validated;
  try {
    validated = validateEventData(req.body);
  } catch (error) {
    // Validation failed — client sent bad data → 400
    console.error('Validation error:', error.message);
    await logError(error, req.body, { endpoint: '/track', ip: req.ip, phase: 'validation' });
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      message: error.message
    });
  }

  try {
    const insertQuery = `
      INSERT INTO public.user_events (
        session_id,
        experiment_run_id,
        user_id,
        event_type,
        event_timestamp,
        payload,
        browser,
        operating_system,
        device_type,
        country
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )
      RETURNING event_id
    `;

    const values = [
      validated.session_id,
      validated.experiment_run_id,
      validated.user_id,
      validated.event_type,
      validated.event_timestamp,
      JSON.stringify(validated.payload),
      validated.browser,
      validated.operating_system,
      validated.device_type,
      validated.country
    ];

    const result = await pool.query(insertQuery, values);

    res.status(200).json({
      success: true,
      message: 'Event recorded successfully',
      event_id: result.rows?.[0]?.event_id
    });

  } catch (error) {
    // Database or server failure — not the client's fault → 500
    console.error('Database error:', error.message);
    await logError(error, req.body, { endpoint: '/track', ip: req.ip, phase: 'database_insert' });
    res.status(500).json({
      success: false,
      error: 'Server failed to record event',
      message: error.message
    });
  }
});

// GET /health — server + database health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    await logError(error, null, { endpoint: '/health' });
    res.status(500).json({ status: 'unhealthy', error: 'Could not access PostgreSQL database' });
  }
});

// GET / — simple status page
app.get('/', (req, res) => {
  res.send('Tracking server is running successfully!');
});

// ─── Global error handling ───────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  logError(err, req.body, { url: req.url, method: req.method });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

process.on('unhandledRejection', async (error) => {
  console.error('Unhandled Promise Rejection:', error);
  await logError(error, null, { type: 'unhandledRejection' });
});

process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await logError(error, null, { type: 'uncaughtException' });
  process.exit(1);
});

// ─── Start ───────────────────────────────────────────────────────────

async function startServer() {
  try {
    const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
      console.log('='.repeat(50));
      console.log(`Server initialized successfully:`);
      console.log(`- Port: ${CONFIG.PORT}`);
      console.log(`- Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`- Logs Path: ${CONFIG.LOG_PATH}`);
      console.log(`- /data endpoint: ${CONFIG.ADMIN_SECRET ? 'protected by ADMIN_SECRET' : 'DISABLED (no ADMIN_SECRET set)'}`);
      console.log(`- Event types: ${VALID_EVENT_TYPES.join(', ')}`);
      console.log('='.repeat(50));
    });

    process.on('SIGTERM', () => {
      console.log('SIGTERM received. Shutting down gracefully...');
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    await logError(error, null, { phase: 'server startup' });
    process.exit(1);
  }
}

startServer();
