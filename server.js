const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Octokit } = require('@octokit/rest');  // Add Octokit requirement

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    CSV_PATH: path.join(__dirname, 'data', 'user_decisions.csv'),
    LOG_PATH: path.join(__dirname, 'logs'),
    MAX_REQUEST_SIZE: '1mb',
    CORS_ORIGINS: [
        'https://radiant-concha-b54632.netlify.app'
    ],
    RATE_LIMIT: {
        windowMs: 15 * 60 * 1000,
        max: 100
    },
    // Add GitHub configuration
    GITHUB: {
        TOKEN: process.env.GITHUB_TOKEN,
        REPO: process.env.GITHUB_REPO,
        BRANCH: process.env.GITHUB_BRANCH,
        FILE_PATH: process.env.CSV_FILE_PATH
    }
};

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
    exposedHeaders: ['Content-Disposition'] // Important for CSV download
}));

app.use(express.json({ limit: CONFIG.MAX_REQUEST_SIZE }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit(CONFIG.RATE_LIMIT);
app.use('/track', limiter);

// Request logging
app.use(morgan(':method :url :status :response-time ms'));

// CSV Configuration
const CSV_HEADERS = [
    { id: 'sessionId', title: 'Session_ID' },
    { id: 'userId', title: 'User_ID' },
    { id: 'ip', title: 'IP_Address' },
    { id: 'browser', title: 'Browser' },
    { id: 'os', title: 'Operating_System' },
    { id: 'device_type', title: 'Device_Type' },
    { id: 'consent_decision', title: 'Consent_Decision' },
    { id: 'consent_timestamp', title: 'Consent_Timestamp' },
    { id: 'decision', title: 'Permission_Decision' },
    { id: 'surveyClicked', title: 'Survey_Clicked' },
    { id: 'timestamp', title: 'Timestamp' }
];

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

// Add GitHub upload function
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
            // File doesn't exist yet, which is fine
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

// Validate tracking data
function validateTrackingData(data) {
    const errors = [];

    if (!data.sessionId) {
        errors.push('Session ID is required');
    } else if (!/^session_\d+_[a-zA-Z0-9]+$/.test(data.sessionId)) {
        errors.push('Invalid Session ID format');
    }

    if (!data.userId) {
        errors.push('User ID is required');
    } else if (!/^user_\d+_[a-zA-Z0-9]+$/.test(data.userId)) {
        errors.push('Invalid User ID format');
    }

    if (!data.ip) {
        errors.push('IP address is required');
    } else if (data.ip.length > 45) {
        errors.push('IP address too long');
    }

    if (!data.browser) {
        errors.push('Browser information is required');
    }

    if (!data.os) {
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

    if (!data.decision) {
        errors.push('Decision is required');
    } else {
        const validDecisions = ['allow', 'block', 'dismiss'];
        if (!validDecisions.includes(data.decision)) {
            errors.push('Invalid decision value. Must be allow, block, or dismiss');
        }
    }

    if (errors.length > 0) {
        throw new Error(errors.join(', '));
    }

    return {
        sessionId: String(data.sessionId),
        userId: String(data.userId),
        ip: String(data.ip).slice(0, 45),
        browser: String(data.browser),
        os: String(data.os),
        device_type: String(data.device_type),
        consent_decision: String(data.consent_decision),
        consent_timestamp: String(data.consent_timestamp),
        decision: String(data.decision),
        timestamp: new Date().toISOString(),
        surveyClicked: Boolean(data.surveyClicked)
    };
}

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

// Get CSV data endpoint
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

// Track endpoint - modified to include GitHub upload
app.post('/track', async (req, res) => {
    try {
        console.log('Received tracking request:', {
            sessionId: req.body.sessionId,
            userId: req.body.userId,
            browser: req.body.browser,
            os: req.body.os,
            device_type: req.body.device_type,
            consent_decision: req.body.consent_decision,
            consent_timestamp: req.body.consent_timestamp,
            decision: req.body.decision,
            surveyClicked: req.body.surveyClicked
        });

        const validatedData = validateTrackingData(req.body);

        // Write to CSV with retry logic
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

        // Add GitHub upload after successful CSV write
        await uploadCSVToGitHub();

        console.log('Tracking data recorded successfully:', {
            sessionId: validatedData.sessionId,
            userId: validatedData.userId,
            ip: validatedData.ip,
            browser: validatedData.browser,
            os: validatedData.os,
            device_type: validatedData.device_type,
            consent_decision: validatedData.consent_decision,
            consent_timestamp: validatedData.consent_timestamp,
            decision: validatedData.decision,
            surveyClicked: validatedData.surveyClicked
        });

        res.status(200).json({
            success: true,
            message: 'Decision recorded and uploaded to GitHub successfully',
            timestamp: validatedData.timestamp
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

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        await fs.access(CONFIG.CSV_PATH);
        
        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            csvPath: CONFIG.CSV_PATH,
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        await logError(error, null, { endpoint: '/health' });
        res.status(500).json({
            status: 'unhealthy',
            error: 'Could not access required files'
        });
    }
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
        await ensureDirectories();

        const server = app.listen(CONFIG.PORT, () => {
            console.log('='.repeat(50));
            console.log(`Server initialized successfully:`);
            console.log(`- Port: ${CONFIG.PORT}`);
            console.log(`- Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`- CSV Path: ${CONFIG.CSV_PATH}`);
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

app.get('/', (req, res) => {
    res.send('Tracking server is running successfully!');
});

// Start the server
startServer();
