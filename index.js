// Load environment variables
require('dotenv').config();

// Import dependencies
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const admin = require('firebase-admin');

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
});

// MongoDB connection
const client = new MongoClient(process.env.MONGODB_URI);
let db;

// Connect to MongoDB
async function connectDB() {
    try {
        await client.connect();
        db = client.db('rewise');
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}

// Collection references
const getUsersCollection = () => db.collection('users');
const getLessonsCollection = () => db.collection('lessons');

// JWT Verification Middleware
async function verifyToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);

        // Sync user with database
        const usersCollection = getUsersCollection();
        const email = decodedToken.email;

        let user = await usersCollection.findOne({ email });

        if (!user) {
            // Create new user with default values
            const newUser = {
                name: decodedToken.name || 'Anonymous',
                email: email,
                photo: decodedToken.picture || '',
                role: 'user',
                isPremium: false,
                createdAt: new Date()
            };
            await usersCollection.insertOne(newUser);
            user = newUser;
        }

        // Attach user info to request
        req.user = {
            email: user.email,
            uid: decodedToken.uid,
            role: user.role,
            isPremium: user.isPremium
        };

        next();
    } catch (error) {
        console.error('Token verification error:', error);
        return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }
}

// Root route - Health check
app.get('/', (req, res) => {
    res.send('Rewise server is running');
});

// Test protected route
app.get('/api/test-auth', verifyToken, (req, res) => {
    res.json({
        message: 'Authentication successful',
        user: req.user
    });
});

// Get current user profile
app.get('/api/user/me', verifyToken, async (req, res) => {
    try {
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({ email: req.user.email });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(user);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create a new lesson
app.post('/api/lessons', verifyToken, async (req, res) => {
    try {
        const { title, description, category, emotionalTone, image, visibility, accessLevel } = req.body;

        // Validate required fields
        if (!title || !description || !category || !emotionalTone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check if user can create premium lessons
        if (accessLevel === 'premium' && !req.user.isPremium) {
            return res.status(403).json({ error: 'Only premium users can create premium lessons' });
        }

        // Create lesson document
        const newLesson = {
            title,
            description,
            category,
            emotionalTone,
            image: image || '',
            visibility: visibility || 'public',
            accessLevel: accessLevel || 'free',
            creatorEmail: req.user.email,
            likesCount: 0,
            likes: [],
            createdAt: new Date()
        };

        const lessonsCollection = getLessonsCollection();
        const result = await lessonsCollection.insertOne(newLesson);

        res.status(201).json({
            message: 'Lesson created successfully',
            lessonId: result.insertedId
        });
    } catch (error) {
        console.error('Error creating lesson:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server after DB connection
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Rewise server is running on port ${PORT}`);
    });
});
