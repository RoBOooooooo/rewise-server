// Load environment variables
require('dotenv').config();

// Import dependencies
const express = require('express');
const cors = require('cors');

// Initialize Express app
const app = express();

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON request bodies

// Root route - Health check
app.get('/', (req, res) => {
    res.send('Rewise server is running');
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ Rewise server is running on port ${PORT}`);
});
