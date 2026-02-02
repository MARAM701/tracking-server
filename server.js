const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
//const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Octokit } = require('@octokit/rest'); 
const { Pool } = require('pg'); // <-- NEW: PostgreSQL client 
const required = ["DB_USER", "DB_HOST", "DB_NAME", "DB_PASS", "DB_PORT"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error("Missing env vars: " + missing.join(", "));
}
// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
     // CSV_PATH: path.join(__dirname, 'data', 'user_decisions.csv'),
    LOG_PATH: path.join(__dirname, 'logs'),
    MAX_REQUEST_SIZE: '1mb',
    CORS_ORIGINS: [
        'https://radiant-concha-b54632.netlify.app'
    ],
    RATE_LIMIT: {
        windowMs: 15 * 60 * 1000,
        max: 100
    },
    GITHUB: {
        TOKEN: process.env.GITHUB_TOKEN,
        REPO: process.env.GITHUB_REPO,
        BRANCH: process.env.GITHUB_BRANCH,
        FILE_PATH: process.env.CSV_FILE_PATH
    }, 
        DB: { // <-- NEW: Add your DB config here
        user: process.env.DB_USER ,
        host: process.env.DB_HOST ,
        database: process.env.DB_NAME ,
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


// Initialize Express app
const app = express();
app.set('trust proxy', 1);

// Initialize GitHub client
const octokit = new Octokit({ auth: CONFIG.GITHUB.TOKEN });

// Middleware setup
app.use(cors({
    origin: CONFIG.CORS_ORIGINS,
    methods: ['POST', 'GET'],
    allowedHeaders: ['Content-Type'],
    exposedHeaders: ['Content-Disposition']
}));

app.use(express.json({ limit: CONFIG.MAX_REQUEST_SIZE }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit(CONFIG.RATE_LIMIT);
app.use('/track', limiter);

// Request logging
app.use(morgan(':method :url :status :response-time ms'));

// CSV Configuration 
/*
const CSV_HEADERS = [
    { id: 'session_id', title: 'Session_ID' }, 
    { id: 'experiment_run_id', title: 'Experiment_Run_ID' },
    { id: 'user_id', title: 'User_ID' },
    { id: 'ip_address', title: 'IP_Address' }, 
    { id: 'country', title: 'Country' },  // Add this line
    { id: 'browser', title: 'Browser' },
    { id: 'operating_system', title: 'Operating_System' },
    { id: 'device_type', title: 'Device_Type' },
    { id: 'consent_decision', title: 'Consent_Decision' },
    { id: 'consent_timestamp', title: 'Consent_Timestamp' }, 
    { id: 'icon_timestamp', title: 'Icon_Timestamp' },  // Add this new line
    { id: 'permission_decision', title: 'Permission_Decision' },
    { id: 'decision_timestamp', title: 'Decision_Timestamp' }, 
    { id: 'decision_time_taken_sec', title: 'Decision_Time_Taken_Sec' },
    { id: 'survey_clicked', title: 'Survey_Clicked' },
    { id: 'survey_timestamp', title: 'Survey_Timestamp' }
]; 
*/
function calculateDecisionTime(iconTimestamp, decisionTimestamp) {
    try {
        const startTime = new Date(iconTimestamp).getTime();
        const endTime = new Date(decisionTimestamp).getTime();
        return (endTime - startTime) / 1000; // Returns seconds with full precision
    } catch (error) {
        console.error('Error calculating decision time:', error);
        return null;
    }
} 
/*
// Function to create new CSV writer 
function createNewCsvWriter(append = true) {
    return createCsvWriter({
        path: CONFIG.CSV_PATH,
        header: CSV_HEADERS,
        append: append
    });
}

// Initialize CSV writer
let csvWriter = createNewCsvWriter(true);

// Ensure required directories exist
async function ensureDirectories() {
    try {
        await fs.mkdir(path.dirname(CONFIG.CSV_PATH), { recursive: true });
        await fs.mkdir(CONFIG.LOG_PATH, { recursive: true });
        
        try {
            await fs.access(CONFIG.CSV_PATH);
            const stats = await fs.stat(CONFIG.CSV_PATH);
            if (stats.size === 0) {
                csvWriter = createNewCsvWriter(false);
                await csvWriter.writeRecords([]);
                console.log('Created new CSV file with headers');
            }
        } catch {
            csvWriter = createNewCsvWriter(false);
            await csvWriter.writeRecords([]);
            console.log('Created new CSV file with headers');
        }
    } catch (error) {
        console.error('Error creating directories:', error);
        throw error;
    }
}
*/ 
// Initialize PostgreSQL connection pool
const pool = new Pool(CONFIG.DB);  
// Add this line to create logs directory
fs.mkdir(CONFIG.LOG_PATH, { recursive: true }).catch(() => {});
/*
// GitHub upload function
async function uploadCSVToGitHub() {
    try {
        const content = await fs.readFile(CONFIG.CSV_PATH, 'utf8');
        const base64Content = Buffer.from(content).toString('base64');
        const [owner, repo] = CONFIG.GITHUB.REPO.split('/');

        // Get current file SHA
        let sha;
        try {
            const { data: fileData } = await octokit.repos.getContent({
                owner,
                repo,
                path: CONFIG.GITHUB.FILE_PATH,
                ref: CONFIG.GITHUB.BRANCH
            });
            sha = fileData.sha;
        } catch (error) {
            if (error.status !== 404) throw error;
        }

        // Create or update file
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: CONFIG.GITHUB.FILE_PATH,
            message: 'Update tracking data',
            content: base64Content,
            sha,
            branch: CONFIG.GITHUB.BRANCH
        });

        console.log('Successfully uploaded CSV to GitHub');
    } catch (error) {
        console.error('Error uploading to GitHub:', error);
        await logError(error, null, { phase: 'github upload' });
    }
}
*/ 

// Error logging function
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

// Validate tracking data
function validateTrackingData(data) {
    const errors = [];

    if (!data.session_id) {
        errors.push('Session ID is required');
    } else if (!/^session_\d+_[a-zA-Z0-9]+$/.test(data.session_id)) {
        errors.push('Invalid Session ID format');
    } 

    if (!data.experiment_run_id) {
        errors.push('Experiment Run ID is required');
    } else if (!/^run_\d+_[a-zA-Z0-9]+$/.test(data.experiment_run_id)) {
        errors.push('Invalid Experiment Run ID format');
    }

    if (!data.user_id) {
        errors.push('User ID is required');
    } else if (!/^user_\d+_[a-zA-Z0-9]+$/.test(data.user_id)) {
        errors.push('Invalid User ID format');
    }

    if (!data.ip_address) {
        errors.push('IP address is required');
    } else if (data.ip_address.length > 45) {
        errors.push('IP address too long');
    }  
    
    if (!data.country) {
        errors.push('Country information is required');
    } else if (typeof data.country !== 'string') {
        errors.push('Country must be a string');
    }

    if (!data.browser) {
        errors.push('Browser information is required');
    }

    if (!data.operating_system) {
        errors.push('Operating System information is required');
    }

    if (!data.device_type) {
        errors.push('Device type is required');
    } else if (!['Desktop', 'Tablet', 'Mobile'].includes(data.device_type)) {
        errors.push('Invalid device type. Must be Desktop, Tablet, or Mobile');
    }

    if (!data.consent_decision) {
        errors.push('Consent decision is required');
    } else if (!['Agree', 'Disagree'].includes(data.consent_decision)) {
        errors.push('Invalid consent decision. Must be Agree or Disagree');
    }

    if (!data.consent_timestamp) {
        errors.push('Consent timestamp is required');
    }

    if (!data.permission_decision) {
        errors.push('Permission decision is required');
    } else {
        const validDecisions = ['allow', 'block', 'dismiss'];
        if (!validDecisions.includes(data.permission_decision)) {
            errors.push('Invalid permission decision value. Must be allow, block, or dismiss');
        }
    }

    if (!data.decision_timestamp) {
        errors.push('Decision timestamp is required');
    }

    if (errors.length > 0) {
        throw new Error(errors.join(', '));
    }
    const decisionTime = calculateDecisionTime(data.icon_timestamp, data.decision_timestamp);
    return {
        session_id: String(data.session_id),  
        user_step: data.user_step || 1,  // ADD THIS LINE
        experiment_run_id: String(data.experiment_run_id),
        user_id: String(data.user_id),
        ip_address: String(data.ip_address).slice(0, 45), 
        country: String(data.country),  // Add this line
        browser: String(data.browser),
        operating_system: String(data.operating_system),
        device_type: String(data.device_type),
        consent_decision: String(data.consent_decision),
        consent_timestamp: String(data.consent_timestamp), 
        icon_timestamp: String(data.icon_timestamp),  // Add this new line
        permission_decision: String(data.permission_decision),
        decision_timestamp: String(data.decision_timestamp), 
        decision_time_taken_sec: decisionTime,
        survey_clicked: data.survey_clicked ? 'true' : 'N/A',
        survey_timestamp: data.survey_clicked ? String(data.survey_timestamp) : 'N/A'
    };
}
/*
// Endpoints
app.get('/data', async (req, res) => {
    try {
        const fileExists = await fs.access(CONFIG.CSV_PATH)
            .then(() => true)
            .catch(() => false);

        if (!fileExists) {
            return res.status(404).json({
                success: false,
                error: 'No data available'
            });
        }

        const data = await fs.readFile(CONFIG.CSV_PATH, 'utf-8');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=user_decisions.csv');
        res.send(data);
    } catch (error) {
        await logError(error, null, { endpoint: '/data' });
        res.status(500).json({
            success: false,
            error: 'Failed to read CSV data'
        });
    }
});
*/ 
app.get('/data', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM user_decisions ORDER BY decision_timestamp DESC'); // change table name if needed
        res.status(200).json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        await logError(error, null, { endpoint: '/data' });
        res.status(500).json({
            success: false,
            error: 'Failed to read data from database'
        });
    }
});

app.post('/track', async (req, res) => {
    try {
        console.log('Received tracking request:', {
            session_id: req.body.session_id, 
            user_step: req.body.user_step,  // ADD THIS LINE
            user_id: req.body.user_id,
            ip_address: req.body.ip_address, 
            country: req.body.country,  // Add this line
            browser: req.body.browser,
            operating_system: req.body.operating_system,
            device_type: req.body.device_type,
            consent_decision: req.body.consent_decision,
            consent_timestamp: req.body.consent_timestamp, 
            icon_timestamp: req.body.icon_timestamp,  // Add this new line
            permission_decision: req.body.permission_decision,
            decision_timestamp: req.body.decision_timestamp,
            survey_clicked: req.body.survey_clicked,
            survey_timestamp: req.body.survey_timestamp
        });

        const validatedData = validateTrackingData(req.body); 
        // --- REMOVED: CSV and GitHub logic
        /*

        let retries = 3;
        let success = false;
        while (retries > 0 && !success) {
            try {
                await csvWriter.writeRecords([validatedData]);
                success = true;
            } catch (error) {
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        await uploadCSVToGitHub(); 
        */ 
                // --- NEW: Insert into PostgreSQL
        const insertQuery = `
            INSERT INTO user_decisions (
                session_id, user_step, experiment_run_id, user_id, ip_address, country,
                browser, operating_system, device_type, consent_decision, consent_timestamp,
                icon_timestamp, permission_decision, decision_timestamp, decision_time_taken_sec,
                survey_clicked, survey_timestamp
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        `;
        const values = [
            validatedData.session_id, 
            validatedData.user_step,  // ADD THIS LINE (becomes value $2)
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
        await pool.query(insertQuery, values);

        console.log('Tracking data recorded successfully:', validatedData);

        res.status(200).json({
            success: true,
            message: 'Decision recorded successfully'
        });

    } catch (error) {
        console.error('Error processing tracking data:', error);
        await logError(error, req.body, {
            endpoint: '/track',
            ip: req.ip,
            headers: req.headers
        });

        res.status(400).json({
            success: false,
            error: 'Failed to record decision',
            message: error.message
        });
    }
});

app.get('/health', async (req, res) => {
    try {
        // await fs.access(CONFIG.CSV_PATH);
        // NEW: Test database connection
        await pool.query('SELECT 1'); 
        
        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            // csvPath: CONFIG.CSV_PATH,
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        await logError(error, null, { endpoint: '/health' });
        res.status(500).json({
            status: 'unhealthy',
            error: 'Could not access PostgreSQL database'
        });
    }
});

app.get('/', (req, res) => {
    res.send('Tracking server is running successfully!');
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    logError(err, req.body, {
        url: req.url,
        method: req.method,
        headers: req.headers
    });

    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
});

// Process error handling
process.on('unhandledRejection', async (error) => {
    console.error('Unhandled Promise Rejection:', error);
    await logError(error, null, { type: 'unhandledRejection' });
});

process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await logError(error, null, { type: 'uncaughtException' });
    process.exit(1);
});

// Server initialization
async function startServer() {
    try {
        // await ensureDirectories();

        const server = app.listen(CONFIG.PORT, () => {
            console.log('='.repeat(50));
            console.log(`Server initialized successfully:`);
            console.log(`- Port: ${CONFIG.PORT}`);
            console.log(`- Environment: ${process.env.NODE_ENV || 'development'}`);
            // console.log(`- CSV Path: ${CONFIG.CSV_PATH}`);
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
