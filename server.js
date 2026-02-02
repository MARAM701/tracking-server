const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Octokit } = require('@octokit/rest');
const { Pool } = require('pg');

const required = ["DB_USER", "DB_HOST", "DB_NAME", "DB_PASS", "DB_PORT"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error("Missing env vars: " + missing.join(", "));
}

const CONFIG = {
  PORT: process.env.PORT || 3000,
  LOG_PATH: path.join(__dirname, 'logs'),
  MAX_REQUEST_SIZE: '1mb',
  CORS_ORIGINS: ['https://radiant-concha-b54632.netlify.app'],
  RATE_LIMIT: { windowMs: 15 * 60 * 1000, max: 100 },
  GITHUB: {
    TOKEN: process.env.GITHUB_TOKEN,
    REPO: process.env.GITHUB_REPO,
    BRANCH: process.env.GITHUB_BRANCH,
    FILE_PATH: process.env.CSV_FILE_PATH
  },
  DB: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS,
    port: Number(process.env.DB_PORT),
    ssl: { rejectUnauthorized: false } // Supabase usually needs SSL
  }
};

console.log("DB CONFIG (no password):", {
  host: CONFIG.DB.host,
  port: CONFIG.DB.port,
  database: CONFIG.DB.database,
  user: CONFIG.DB.user,
  ssl: !!CONFIG.DB.ssl
});

const app = express();
app.set('trust proxy', 1);

const octokit = new Octokit({ auth: CONFIG.GITHUB.TOKEN });

app.use(cors({
  origin: CONFIG.CORS_ORIGINS,
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type'],
  exposedHeaders: ['Content-Disposition']
}));

app.use(express.json({ limit: CONFIG.MAX_REQUEST_SIZE }));
app.use(express.static('public'));

const limiter = rateLimit(CONFIG.RATE_LIMIT);
app.use('/track', limiter);

app.use(morgan(':method :url :status :response-time ms'));

// Ensure logs directory exists
fs.mkdir(CONFIG.LOG_PATH, { recursive: true }).catch(() => {});

// PostgreSQL pool
const pool = new Pool(CONFIG.DB);

// --- Helpers ---
function calculateDecisionTime(iconTimestamp, decisionTimestamp) {
  try {
    if (!iconTimestamp || !decisionTimestamp) return null;
    const startTime = new Date(iconTimestamp).getTime();
    const endTime = new Date(decisionTimestamp).getTime();
    if (Number.isNaN(startTime) || Number.isNaN(endTime)) return null;
    return (endTime - startTime) / 1000;
  } catch {
    return null;
  }
}

function toNullableText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toNullableInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNullableTimestamp(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  // pg can accept Date objects
  return d;
}

// Error logging
async function logError(error, requestData = null, additionalInfo = {}) {
  const errorLog = {
    timestamp: new Date().toISOString(),
    error: error.message,
    stack: error.stack,
    requestData,
    ...additionalInfo
  };

  const logFile = path.join(CONFIG.LOG_PATH, `error_${new Date().toISOString().split('T')[0]}.log`);
  try {
    await fs.appendFile(logFile, JSON.stringify(errorLog) + '\n');
  } catch (err) {
    console.error('Error writing to log file:', err);
  }
}

// Validate (aligned with DB schema)
function validateTrackingData(data) {
  const errors = [];

  // DB NOT NULL fields:
  if (!data.session_id) errors.push('session_id is required');
  if (!data.experiment_run_id) errors.push('experiment_run_id is required');
  if (!data.user_id) errors.push('user_id is required');

  // user_step in DB is NOT NULL with default 1
  // But your client sends it, so accept if provided, otherwise default 1
  const user_step = data.user_step ?? 1;
  const userStepInt = toNullableInt(user_step);
  if (!userStepInt || userStepInt < 1) errors.push('user_step must be an integer >= 1');

  // Optional but if present validate basic form
  const permissionDecision = toNullableText(data.permission_decision);
  if (permissionDecision) {
    const valid = ['allow', 'block', 'dismiss'];
    if (!valid.includes(permissionDecision)) {
      errors.push('permission_decision must be allow, block, or dismiss (or omitted)');
    }
  }

  const consentDecision = toNullableText(data.consent_decision);
  if (consentDecision) {
    const validConsent = ['Agree', 'Disagree'];
    if (!validConsent.includes(consentDecision)) {
      errors.push('consent_decision must be Agree or Disagree (or omitted)');
    }
  }

  if (errors.length) {
    throw new Error(errors.join(', '));
  }

  const iconTs = toNullableTimestamp(data.icon_timestamp);
  const decisionTs = toNullableTimestamp(data.decision_timestamp);
  const decisionTime = calculateDecisionTime(iconTs, decisionTs);

  return {
    session_id: String(data.session_id),
    user_step: userStepInt,
    experiment_run_id: String(data.experiment_run_id),
    user_id: String(data.user_id),

    ip_address: toNullableText(data.ip_address),
    country: toNullableText(data.country),
    browser: toNullableText(data.browser),
    operating_system: toNullableText(data.operating_system),
    device_type: toNullableText(data.device_type),

    consent_decision: consentDecision,
    consent_timestamp: toNullableTimestamp(data.consent_timestamp),

    icon_timestamp: iconTs,
    permission_decision: permissionDecision,

    decision_timestamp: decisionTs,
    decision_time_taken_sec: decisionTime,

    survey_clicked: toNullableText(data.survey_clicked),   // store what you send (or null)
    survey_timestamp: toNullableTimestamp(data.survey_timestamp),
  };
}

// --- Routes ---

app.get('/data', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM public.user_decisions ORDER BY created_at DESC'
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    await logError(error, null, { endpoint: '/data' });
    res.status(500).json({ success: false, error: 'Failed to read data from database' });
  }
});

app.post('/track', async (req, res) => {
  try {
    const validatedData = validateTrackingData(req.body);

    const insertQuery = `
      INSERT INTO public.user_decisions (
        session_id,
        user_step,
        experiment_run_id,
        user_id,
        ip_address,
        country,
        browser,
        operating_system,
        device_type,
        consent_decision,
        consent_timestamp,
        icon_timestamp,
        permission_decision,
        decision_timestamp,
        decision_time_taken_sec,
        survey_clicked,
        survey_timestamp
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
      )
      RETURNING id
    `;

    const values = [
      validatedData.session_id,
      validatedData.user_step,
      validatedData.experiment_run_id,
      validatedData.user_id,
      validatedData.ip_address,
      validatedData.country,
      validatedData.browser,
      validatedData.operating_system,
      validatedData.device_type,
      validatedData.consent_decision,
      validatedData.consent_timestamp,
      validatedData.icon_timestamp,
      validatedData.permission_decision,
      validatedData.decision_timestamp,
      validatedData.decision_time_taken_sec,
      validatedData.survey_clicked,
      validatedData.survey_timestamp
    ];

    const result = await pool.query(insertQuery, values);

    res.status(200).json({
      success: true,
      message: 'Decision recorded successfully',
      id: result.rows?.[0]?.id
    });

  } catch (error) {
    console.error('Error processing tracking data:', error);
    await logError(error, req.body, { endpoint: '/track', ip: req.ip });

    res.status(400).json({
      success: false,
      error: 'Failed to record decision',
      message: error.message
    });
  }
});

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

app.get('/', (req, res) => {
  res.send('Tracking server is running successfully!');
});

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

async function startServer() {
  try {
    const server = app.listen(CONFIG.PORT, () => {
      console.log('='.repeat(50));
      console.log(`Server initialized successfully:`);
      console.log(`- Port: ${CONFIG.PORT}`);
      console.log(`- Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`- Logs Path: ${CONFIG.LOG_PATH}`);
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
