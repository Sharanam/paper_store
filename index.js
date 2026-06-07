const express = require('express');
const pg = require('pg');
const axios = require('axios');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse incoming JSON payloads
app.use(express.json());

// Basic Auth for all /api routes
const API_USER = process.env.API_USER || 'admin';
const API_PASS = process.env.API_PASS || 'password';

function basicAuthMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Research API"');
        return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const b64 = auth.split(' ')[1] || '';
    let creds = '';
    try {
        creds = Buffer.from(b64, 'base64').toString('utf8');
    } catch (err) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Research API"');
        return res.status(401).json({ error: 'Invalid Authorization header' });
    }

    const [user, pass] = creds.split(':');
    if (user === API_USER && pass === API_PASS) return next();

    res.setHeader('WWW-Authenticate', 'Basic realm="Research API"');
    return res.status(401).json({ error: 'Invalid credentials' });
}

// Apply basic auth globally so the browser will prompt on first page load
app.use(basicAuthMiddleware);

const config = {
    user: process.env.dbuser || "avnadmin",
    password: process.env.dbpswd,
    host: process.env.dbhost || "your-db-host",
    port: 24954,
    database: "defaultdb",
    ssl: {
        rejectUnauthorized: true,
        ca: process.env.dbssl || null,
    },
};

const pool = new pg.Pool(config);

pool.on('error', (err) => {
    console.error("Database connection failure:", err.message);
});

// Create table schema if it doesn't exist
pool.query(`CREATE TABLE IF NOT EXISTS saved_papers (
    doi TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    authors TEXT,
    publication_year INTEGER,
    publisher TEXT,
    remarks TEXT,
    is_deleted BOOLEAN DEFAULT FALSE,
    saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`, async (err) => {
    if (err) {
        console.error("Table initialization error:", err.message);
    } else {
        console.log("Connected securely to the PostgreSQL database.");
    }
});

/**
 * Endpoint 1: Universal search supporting multiple engines
 * GET /api/search?q=query_string&engine=openalex|crossref
 */
app.get('/api/search', async (req, res) => {
    const queryString = req.query.q;
    const engine = req.query.engine || 'openalex';

    if (!queryString) {
        return res.status(400).json({ error: "Missing query string parameter 'q'." });
    }

    try {
        let suggestions = [];

        if (engine === 'crossref') {
            const response = await axios.get('https://api.crossref.org/works', {
                params: { query: queryString, rows: 5 },
                headers: { 'User-Agent': 'ResearchPaperCollector/1.0 (mailto:admin@example.com)' }
            });

            const items = response.data.message?.items || [];
            suggestions = items.map(paper => {
                const authorNames = paper.author
                    ? paper.author.map(a => `${a.given || ''} ${a.family || ''}`.trim()).join(', ')
                    : 'Unknown Author';

                return {
                    title: paper.title && paper.title[0] ? paper.title[0] : 'Untitled Paper',
                    doi: paper.DOI ? `https://doi.org/${paper.DOI}` : null,
                    authors: authorNames,
                    publication_year: paper.created?.['date-parts']?.[0]?.[0] || null,
                    publisher: paper.publisher || 'Unknown Publisher'
                };
            });
        } else {
            const response = await axios.get('https://api.openalex.org/works', {
                params: { search: queryString, per_page: 5 }
            });

            suggestions = response.data.results.map(paper => {
                const authorNames = paper.authorships
                    ? paper.authorships.map(a => a.author.display_name).join(', ')
                    : 'Unknown Author';

                return {
                    title: paper.display_name || 'Untitled Paper',
                    doi: paper.doi || null,
                    authors: authorNames,
                    publication_year: paper.publication_year || null,
                    publisher: paper.primary_location?.source?.display_name || 'Unknown Publisher'
                };
            });
        }

        res.json({ success: true, results: suggestions });

    } catch (error) {
        console.error("REST API extraction error:", error.message);
        res.status(500).json({ error: `Failed fetching data from target academic registry (${engine}).` });
    }
});

/**
 * Endpoint 2: Store/Restore selected paper
 * POST /api/save
 */
app.post('/api/save', async (req, res) => {
    const { doi, title, authors, publication_year, publisher, remarks } = req.body;

    if (!doi || !title) {
        return res.status(400).json({ error: "DOI and Title are mandatory data points." });
    }

    const sql = `INSERT INTO saved_papers (doi, title, authors, publication_year, publisher, remarks, is_deleted)
                 VALUES ($1, $2, $3, $4, $5, $6, FALSE)
                 ON CONFLICT (doi) DO UPDATE SET is_deleted = FALSE, remarks = COALESCE($6, saved_papers.remarks)`;
    const params = [doi, title, authors || null, publication_year || null, publisher || null, remarks || null];

    try {
        await pool.query(sql, params);
        return res.json({ success: true, message: 'Paper record stored successfully.', insertedId: doi });
    } catch (err) {
        console.error('SQL insertion error:', err.message);
        return res.status(500).json({ error: 'Failed to persist academic record.' });
    }
});

/**
 * Endpoint 3: Fetch active records
 * GET /api/saved-papers
 */
app.get('/api/saved-papers', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM saved_papers WHERE is_deleted = FALSE ORDER BY saved_at DESC');
        res.json({ success: true, results: result.rows });
    } catch (err) {
        console.error('SQL query error:', err.message);
        res.status(500).json({ error: 'Failed to fetch saved papers.' });
    }
});

/**
 * Endpoint 4: Soft-delete record
 * DELETE /api/saved-papers
 */
app.delete('/api/saved-papers', async (req, res) => {
    const { doi } = req.body;
    if (!doi) {
        return res.status(400).json({ error: "Missing specific target identifier parameter 'doi'." });
    }

    try {
        const result = await pool.query('UPDATE saved_papers SET is_deleted = TRUE WHERE doi = $1', [doi]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Paper not found." });
        }
        res.json({ success: true, message: 'Paper soft-deleted successfully.', deletedId: doi });
    } catch (err) {
        console.error('SQL soft delete operation failure:', err.message);
        res.status(500).json({ error: 'Failed to delete execution pathway.' });
    }
});

// Serve frontend client
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.listen(PORT, () => {
    console.log(`Server executing live on http://localhost:${PORT}`);
});

// Graceful teardown process when server stops
process.on('SIGTERM', async () => {
    console.log("Closing application server...");
    try {
        await pool.end();
        console.log("PostgreSQL connection pool cleared.");
    } catch (err) {
        console.error("Error during database pool shutdown:", err.message);
    }
    process.exit(0);
});