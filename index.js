// Load environment variables
require('dotenv').config();

// Import dependencies
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Express app
const app = express();

// Middleware
app.use(cors());

// Stripe webhook endpoint (must be before express.json())
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userEmail = session.metadata.userEmail || session.client_reference_id;

        if (userEmail) {
            try {
                const usersCollection = getUsersCollection();
                await usersCollection.updateOne(
                    { email: userEmail },
                    { $set: { isPremium: true } }
                );
                console.log(`User ${userEmail} upgraded to premium`);
            } catch (error) {
                console.error('Error updating user premium status:', error);
            }
        }
    }

    res.json({ received: true });
});

// JSON parser for all other routes
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

// Get all public lessons with pagination and filters
app.get('/api/lessons', async (req, res) => {
    try {
        const lessonsCollection = getLessonsCollection();

        // Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Build filter query
        const filter = { visibility: 'public' };

        if (req.query.category) {
            filter.category = req.query.category;
        }

        if (req.query.emotionalTone) {
            filter.emotionalTone = req.query.emotionalTone;
        }

        // Sorting
        const sort = {};
        if (req.query.sort === 'newest') {
            sort.createdAt = -1;
        } else if (req.query.sort === 'oldest') {
            sort.createdAt = 1;
        } else if (req.query.sort === 'popular') {
            sort.likesCount = -1;
        } else {
            sort.createdAt = -1; // Default: newest first
        }

        // Get lessons
        const lessons = await lessonsCollection
            .find(filter)
            .sort(sort)
            .skip(skip)
            .limit(limit)
            .toArray();

        // Get total count for pagination
        const total = await lessonsCollection.countDocuments(filter);

        res.json({
            lessons,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching lessons:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get single lesson by ID
app.get('/api/lessons/:id', async (req, res) => {
    try {
        const { ObjectId } = require('mongodb');
        const lessonsCollection = getLessonsCollection();

        // Validate ObjectId
        if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid lesson ID' });
        }

        const lesson = await lessonsCollection.findOne({
            _id: new ObjectId(req.params.id)
        });

        if (!lesson) {
            return res.status(404).json({ error: 'Lesson not found' });
        }

        // Check visibility
        if (lesson.visibility === 'private') {
            return res.status(403).json({ error: 'This lesson is private' });
        }

        // Check premium access
        if (lesson.accessLevel === 'premium') {
            // Check if user is authenticated and premium
            const authHeader = req.headers.authorization;

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(403).json({
                    error: 'Premium lesson - Authentication required',
                    isPremiumContent: true
                });
            }

            try {
                const token = authHeader.split(' ')[1];
                const decodedToken = await admin.auth().verifyIdToken(token);
                const usersCollection = getUsersCollection();
                const user = await usersCollection.findOne({ email: decodedToken.email });

                if (!user || !user.isPremium) {
                    return res.status(403).json({
                        error: 'Premium lesson - Premium subscription required',
                        isPremiumContent: true
                    });
                }
            } catch (error) {
                return res.status(403).json({
                    error: 'Premium lesson - Invalid authentication',
                    isPremiumContent: true
                });
            }
        }

        res.json(lesson);
    } catch (error) {
        console.error('Error fetching lesson:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create Stripe checkout session for premium upgrade
app.post('/api/create-checkout-session', verifyToken, async (req, res) => {
    try {
        // Check if user is already premium
        if (req.user.isPremium) {
            return res.status(400).json({ error: 'You are already a premium user' });
        }

        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'bdt',
                        product_data: {
                            name: 'Rewise Premium Subscription',
                            description: 'One-time payment for lifetime premium access'
                        },
                        unit_amount: 150000 // ৳1500 in paisa (1500 * 100)
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
            client_reference_id: req.user.email,
            metadata: {
                userEmail: req.user.email
            }
        });

        res.json({
            sessionId: session.id,
            url: session.url
        });
    } catch (error) {
        console.error('Error creating checkout session:', error);
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
