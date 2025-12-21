require("dotenv").config();

// Import dependencies
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const admin = require("firebase-admin");

// Initialize Stripe
const stripe = require("stripe")(
  process.env.STRIPE_SECRET_KEY || "sk_test_placeholder"
);

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn(
    "Warning: STRIPE_SECRET_KEY is missing in .env file. Stripe features will not work."
  );
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "Warning: STRIPE_WEBHOOK_SECRET is missing in .env. Webhooks will fail."
  );
}

// Initialize Express app
const app = express();

// Middleware
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        "http://localhost:5173",
        "https://rewise-arif.vercel.app",
      ];

      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

// Stripe webhook endpoint
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    // Ensure DB is connected for webhook
    await connectDB();

    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout.session.completed event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userEmail =
        session.metadata.userEmail || session.client_reference_id;

      if (userEmail) {
        try {
          const usersCollection = getUsersCollection();
          await usersCollection.updateOne(
            { email: userEmail },
            { $set: { isPremium: true } }
          );
          console.log(`User ${userEmail} upgraded to premium`);
        } catch (error) {
          console.error("Error updating user premium status:", error);
        }
      }
    }

    res.json({ received: true });
  }
);

// JSON parser for all other routes
app.use(express.json());

// Initialize Firebase Admin SDK
if (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
    console.log("Firebase Admin initialized successfully");
  } catch (error) {
    console.error("Firebase initialization error:", error.message);
  }
} else {
  console.warn("Warning: Firebase credentials missing in .env");
}

// MongoDB connection
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/rewise";
const client = new MongoClient(mongoUri);
let db;

// Connect to MongoDB
async function connectDB() {
  if (db) return db;
  try {
    await client.connect();
    db = client.db("rewise");
    console.log("Connected to MongoDB");
    return db;
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
}

// ensure DB is connected middleware
const ensureDbConnected = async (req, res, next) => {
  if (!db) {
    await connectDB();
  }
  next();
};

app.use(ensureDbConnected);

// Collection references
const getUsersCollection = () => {
  if (!db) throw new Error("Database not connected");
  return db.collection("users");
};
const getLessonsCollection = () => {
  if (!db) throw new Error("Database not connected");
  return db.collection("lessons");
};
const getReportsCollection = () => {
  if (!db) throw new Error("Database not connected");
  return db.collection("reports");
};
const getCommentsCollection = () => {
  if (!db) throw new Error("Database not connected");
  return db.collection("comments");
};
const getFavoritesCollection = () => {
  if (!db) throw new Error("Database not connected");
  return db.collection("favorites");
};

// JWT Verification Middleware
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized - No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    // Sync user with database
    const usersCollection = getUsersCollection();
    const email = decodedToken.email;

    let user = await usersCollection.findOne({ email });

    // Attach user info to request
    req.user = {
      email: email,
      uid: decodedToken.uid,
      role: user ? user.role : "user", // Default to user if not found
      isPremium: user ? user.isPremium : false, // Default to false if not found
    };

    next();
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(401).json({ error: "Unauthorized - Invalid token" });
  }
}

// Admin Verification Middleware
async function verifyAdmin(req, res, next) {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(403).json({ error: "FORBIDDEN ACCESS - Admin Only" });
  }
};

/*
 * REPORTING SYSTEM ROUTES
 */

// User reports a lesson
app.post("/api/reports", verifyToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const { lessonId, reason } = req.body;
    const reportsCollection = getReportsCollection();

    if (!ObjectId.isValid(lessonId)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const report = {
      lessonId: new ObjectId(lessonId),
      reason,
      reporterEmail: req.user.email,
      createdAt: new Date(),
    };

    await reportsCollection.insertOne(report);
    res.status(201).json({ message: "Report submitted successfully" });
  } catch (error) {
    console.error("Error reporting lesson:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Admin: Get all reports (optionally filter by lessonId)
app.get("/api/admin/reports", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const reportsCollection = getReportsCollection();
    const { lessonId } = req.query;

    // Build Aggregation Pipeline
    const pipeline = [];

    // 1. Filter by specific lesson (optional)
    if (lessonId) {
      if (!ObjectId.isValid(lessonId)) {
        return res.status(400).json({ error: "Invalid lesson ID" });
      }
      pipeline.push({ $match: { lessonId: new ObjectId(lessonId) } });
    }

    // 2. Lookup Lesson Details
    pipeline.push({
      $lookup: {
        from: "lessons",
        localField: "lessonId",
        foreignField: "_id",
        as: "lesson"
      }
    });

    // 3. Unwind Lesson (keep report even if lesson deleted)
    pipeline.push({
      $unwind: {
        path: "$lesson",
        preserveNullAndEmptyArrays: true
      }
    });

    // 4. Sort by Newest Report
    pipeline.push({ $sort: { createdAt: -1 } });

    const reports = await reportsCollection.aggregate(pipeline).toArray();
    res.json(reports);
  } catch (error) {
    console.error("Error fetching reports:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Admin: Resolve/Delete report
app.delete(
  "/api/admin/reports/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ObjectId } = require("mongodb");
      const reportsCollection = getReportsCollection();

      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid report ID" });
      }

      const result = await reportsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Report not found" });
      }

      res.json({ message: "Report deleted/resolved" });
    } catch (error) {
      console.error("Error deleting report:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Admin: Get aggregated reported lessons
app.get(
  "/api/admin/reported-lessons",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const reportsCollection = getReportsCollection();
      const reportedLessons = await reportsCollection
        .aggregate([
          { $group: { _id: "$lessonId", reportCount: { $sum: 1 } } },
          {
            $lookup: {
              from: "lessons",
              localField: "_id",
              foreignField: "_id",
              as: "lessonDetails",
            },
          },
          { $unwind: "$lessonDetails" },
          {
            $project: {
              _id: "$lessonDetails._id",
              title: "$lessonDetails.title",
              creatorEmail: "$lessonDetails.creatorEmail",
              reportCount: 1,
            },
          },
        ])
        .toArray();

      res.json(reportedLessons);
    } catch (error) {
      console.error("Error fetching reported lessons:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/*
 * users collection schema
 * {
 *   _id: ObjectId,
 *   name: String,
 *   email: String,
 *   photo: String,
 *   role: 'user' | 'admin',
 *   isPremium: Boolean,
 *   favorites: [String], // Array of Lesson IDs
 *   createdAt: Date
 * }
 *
 * lessons collection schema
 * {
 *   _id: ObjectId,
 *   title: String,
 *   description: String,
 *   category: String,
 *   emotionalTone: String,
 *   image: String,
 *   visibility: 'public' | 'private',
 *   accessLevel: 'free' | 'premium',
 *   creatorEmail: String,
 *   likesCount: Number,
 *   likes: [String], // Array of User Emails
 *   createdAt: Date
 * }
 */

/*
 * ADMIN ROUTES
 * Middleware Chain: verifyToken -> verifyAdmin
 */

// Sync/Create User (Call this after Firebase Login)
app.post("/api/users/:email", verifyToken, async (req, res) => {
  try {
    const usersCollection = getUsersCollection();
    const { email } = req.params;
    const { name, photo, uid } = req.body;

    if (email !== req.user.email) {
      return res.status(403).json({ error: "Forbidden access" });
    }

    // Check if user exists
    const existingUser = await usersCollection.findOne({ email });

    if (existingUser) {
      return res.json({ message: "User already exists", user: existingUser });
    }

    // Create new user
    const newUser = {
      name: name || "Anonymous",
      email: email,
      photo: photo || "",
      photo: photo || "",
      uid: uid || "", // Optional: store firebase UID
      role: "user",
      favorites: [],
      isPremium: false,
      createdAt: new Date(),
    };

    const result = await usersCollection.insertOne(newUser);
    newUser._id = result.insertedId;

    res.status(201).json({ message: "User created", user: newUser });
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all users (Admin)
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const usersCollection = getUsersCollection();
    const users = await usersCollection.find().toArray();
    res.json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update user role (Make Admin)
app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ObjectId } = require("mongodb");
      const usersCollection = getUsersCollection();

      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const userId = new ObjectId(req.params.id);
      const { role } = req.body;

      if (role !== "admin" && role !== "user") {
        return res.status(400).json({ error: "Invalid role" });
      }

      const result = await usersCollection.updateOne(
        { _id: userId },
        { $set: { role: role } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ message: `User role updated to ${role}` });
    } catch (error) {
      console.error("Error updating user role:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Delete User (Admin)
app.delete(
  "/api/admin/users/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ObjectId } = require("mongodb");
      const usersCollection = getUsersCollection();

      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      const userId = new ObjectId(req.params.id);
      const result = await usersCollection.deleteOne({ _id: userId });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ message: "User deleted successfully" });
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Get all lessons (Admin) with filtering
app.get("/api/admin/lessons", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const lessonsCollection = getLessonsCollection();
    const { category, visibility, flagged } = req.query;
    let filter = {};

    // Apply category filter
    if (category) {
      filter.category = category;
    }

    // Apply visibility filter
    if (visibility) {
      filter.visibility = visibility;
    }

    // Apply flagged filter (lessons that have reports)
    if (flagged === 'true') {
      const reportsCollection = getReportsCollection();
      const reportedLessonIds = await reportsCollection.distinct('lessonId');
      filter._id = { $in: reportedLessonIds };
    }

    const lessons = await lessonsCollection.find(filter).toArray();
    res.json(lessons);
  } catch (error) {
    console.error("Error fetching admin lessons:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete Lesson (Admin)
app.delete(
  "/api/admin/lessons/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ObjectId } = require("mongodb");
      const lessonsCollection = getLessonsCollection();

      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: "Invalid lesson ID" });
      }

      const lessonId = new ObjectId(req.params.id);
      const result = await lessonsCollection.deleteOne({ _id: lessonId });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Lesson not found" });
      }

      res.json({ message: "Lesson deleted successfully by admin" });
    } catch (error) {
      console.error("Error deleting lesson (admin):", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Admin Dashboard Stats
app.get("/api/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const usersCollection = getUsersCollection();
    const lessonsCollection = getLessonsCollection();

    const totalUsers = await usersCollection.countDocuments();
    const totalLessons = await lessonsCollection.countDocuments();
    const publicLessons = await lessonsCollection.countDocuments({
      visibility: "public",
    });
    const privateLessons = await lessonsCollection.countDocuments({
      visibility: "private",
    });

    // Total unique reported lessons
    const reportsCollection = getReportsCollection();
    const distinctReported = await reportsCollection.distinct("lessonId");
    const totalReportedLessons = distinctReported.length;

    res.json({
      totalUsers,
      totalLessons,
      publicLessons,
      privateLessons,
      totalReportedLessons,
    });
  } catch (error) {
    console.error("Error fetching admin stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/", (req, res) => {
  res.send("Rewise server is running");
});

// Health check route
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Rewise server is healthy",
    timestamp: new Date().toISOString(),
  });
});

// Test protected route
app.get("/api/test-auth", verifyToken, (req, res) => {
  res.json({
    message: "Authentication successful",
    user: req.user,
  });
});

// Get current user profile
app.get("/api/user/me", verifyToken, async (req, res) => {
  try {
    const usersCollection = getUsersCollection();
    const user = await usersCollection.findOne({ email: req.user.email });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(user);
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update User Profile
app.patch("/api/user/me", verifyToken, async (req, res) => {
  try {
    const usersCollection = getUsersCollection();
    const { name, photo } = req.body;
    const updateFields = {};

    if (name) updateFields.name = name;
    if (photo) updateFields.photo = photo;

    await usersCollection.updateOne(
      { email: req.user.email },
      { $set: updateFields }
    );

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Public Analytics (Top Contributors & Most Saved)
app.get("/api/public/analytics", async (req, res) => {
  try {
    const usersCollection = getUsersCollection();
    const lessonsCollection = getLessonsCollection();

    const topContributors = await lessonsCollection
      .aggregate([
        { $group: { _id: "$creatorEmail", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ])
      .toArray();

    const contributorEmails = topContributors.map((c) => c._id);
    const authors = await usersCollection
      .find({ email: { $in: contributorEmails } })
      .project({ password: 0 })
      .toArray();

    const contributorsWithDetails = topContributors.map((tc) => {
      const author = authors.find((a) => a.email === tc._id);
      return {
        ...tc,
        author: author || { name: "Unknown", photo: "" },
      };
    });

    const mostPopularLessons = await lessonsCollection
      .find({ visibility: "public" })
      .sort({ likesCount: -1 })
      .limit(6)
      .toArray();

    res.json({
      topContributors: contributorsWithDetails,
      mostPopularLessons,
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get lessons created by logged-in user
app.get("/api/my-lessons", verifyToken, async (req, res) => {
  try {
    const lessonsCollection = getLessonsCollection();

    const myLessons = await lessonsCollection
      .find({ creatorEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      lessons: myLessons,
      total: myLessons.length,
    });
  } catch (error) {
    console.error("Error fetching user lessons:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create a new lesson
app.post("/api/lessons", verifyToken, async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      emotionalTone,
      image,
      visibility,
      accessLevel,
    } = req.body;

    // Validate required fields
    if (!title || !description || !category || !emotionalTone) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if user can create premium lessons
    if (accessLevel === "premium" && !req.user.isPremium) {
      return res
        .status(403)
        .json({ error: "Only premium users can create premium lessons" });
    }

    // Create lesson document
    const newLesson = {
      title,
      description,
      category,
      emotionalTone,
      image: image || "",
      visibility: visibility || "public",
      accessLevel: accessLevel || "free",
      creatorEmail: req.user.email,
      likesCount: 0,
      likes: [],
      isFeatured: false,
      isReviewed: false,
      createdAt: new Date(),
    };

    const lessonsCollection = getLessonsCollection();
    const result = await lessonsCollection.insertOne(newLesson);

    res.status(201).json({
      message: "Lesson created successfully",
      lessonId: result.insertedId,
    });
  } catch (error) {
    console.error("Error creating lesson:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all public lessons with pagination and filters
app.get("/api/lessons", async (req, res) => {
  try {
    const lessonsCollection = getLessonsCollection();

    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter query
    const filter = { visibility: "public" };

    if (req.query.category) {
      filter.category = req.query.category;
    }

    if (req.query.emotionalTone) {
      filter.emotionalTone = req.query.emotionalTone;
    }

    // Search by title (regex)
    if (req.query.search) {
      filter.title = { $regex: req.query.search, $options: "i" };
    }

    // Filter by Featured
    if (req.query.featured === "true") {
      filter.isFeatured = true;
    }

    // Filter by Creator Email (for "More from this author")
    if (req.query.creatorEmail) {
      filter.creatorEmail = req.query.creatorEmail;
    }

    // Sorting
    const sort = {};
    if (req.query.sort === "newest") {
      sort.createdAt = -1;
    } else if (req.query.sort === "oldest") {
      sort.createdAt = 1;
    } else if (req.query.sort === "popular") {
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

    // Hydrate authors (Join with users collection)
    const usersCollection = getUsersCollection();
    const userEmails = [...new Set(lessons.map((l) => l.creatorEmail))];
    const authors = await usersCollection
      .find({ email: { $in: userEmails } })
      .project({ name: 1, email: 1, photo: 1 })
      .toArray();

    // Get lesson counts for these authors
    const authorCounts = {};
    for (const email of userEmails) {
      authorCounts[email] = await lessonsCollection.countDocuments({ creatorEmail: email });
    }

    const lessonsWithAuthors = lessons.map((lesson) => {
      const author = authors.find((a) => a.email === lesson.creatorEmail);
      const stats = authorCounts[lesson.creatorEmail] || 0;
      return {
        ...lesson,
        author: author
          ? { ...author, lessonsCreated: stats }
          : { name: "Unknown", photo: "", lessonsCreated: 0 },
      };
    });

    // Get total count for pagination
    const total = await lessonsCollection.countDocuments(filter);

    res.json({
      lessons: lessonsWithAuthors,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching lessons:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get single lesson by ID
app.get("/api/lessons/:id", async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const lessonsCollection = getLessonsCollection();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const lesson = await lessonsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found" });
    }

    // Check visibility
    if (lesson.visibility === "private") {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(403).json({ error: "Private lesson - Authentication required" });
      }

      try {
        const token = authHeader.split(" ")[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({ email: decodedToken.email });

        const isCreator = lesson.creatorEmail === decodedToken.email;
        const isAdmin = user && user.role === "admin";

        if (!isCreator && !isAdmin) {
          return res.status(403).json({ error: "Private lesson - Restricted access" });
        }
      } catch (error) {
        return res.status(403).json({ error: "Private lesson - Invalid token" });
      }
    }

    // Check premium access
    if (lesson.accessLevel === "premium") {
      // Check if user is authenticated and premium
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(403).json({
          error: "Premium lesson - Authentication required",
          isPremiumContent: true,
        });
      }

      try {
        const token = authHeader.split(" ")[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne({
          email: decodedToken.email,
        });

        if (!user || !user.isPremium) {
          return res.status(403).json({
            error: "Premium lesson - Premium subscription required",
            isPremiumContent: true,
          });
        }
      } catch (error) {
        return res.status(403).json({
          error: "Premium lesson - Invalid authentication",
          isPremiumContent: true,
        });
      }
    }

    // Attach author details
    const usersCollection = getUsersCollection();
    const author = await usersCollection.findOne(
      { email: lesson.creatorEmail },
      { projection: { name: 1, email: 1, photo: 1 } }
    );

    // Get author statistics
    const lessonsCount = await lessonsCollection.countDocuments({ creatorEmail: lesson.creatorEmail });

    res.json({
      ...lesson,
      author: author
        ? { ...author, lessonsCreated: lessonsCount }
        : { name: "Unknown", photo: "", lessonsCreated: 0 }
    });
  } catch (error) {
    console.error("Error fetching lesson:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get related/similar lessons
app.get("/api/lessons/related/:id", async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const lessonsCollection = getLessonsCollection();

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const lessonId = new ObjectId(req.params.id);
    const currentLesson = await lessonsCollection.findOne({ _id: lessonId });

    if (!currentLesson) {
      return res.status(404).json({ error: "Lesson not found" });
    }

    // Find related lessons (same category OR same tone, exclude current)
    const relatedLessons = await lessonsCollection
      .find({
        _id: { $ne: lessonId },
        visibility: "public",
        $or: [
          { category: currentLesson.category },
          { emotionalTone: currentLesson.emotionalTone },
        ],
      })
      .limit(6)
      .toArray();

    res.json(relatedLessons);
  } catch (error) {
    console.error("Error fetching related lessons:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create Stripe checkout session for premium upgrade
app.post("/api/create-checkout-session", verifyToken, async (req, res) => {
  try {
    // Check if user is already premium
    if (req.user.isPremium) {
      return res.status(400).json({ error: "You are already a premium user" });
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "bdt",
            product_data: {
              name: "Rewise Premium Subscription",
              description: "One-time payment for lifetime premium access",
            },
            unit_amount: 150000, // ৳1500 in paisa (1500 * 100)
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
      client_reference_id: req.user.email,
      metadata: {
        userEmail: req.user.email,
      },
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Like/Unlike a lesson
app.post("/api/lessons/:id/like", verifyToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const lessonsCollection = getLessonsCollection();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const lessonId = new ObjectId(req.params.id);
    const userEmail = req.user.email;

    // Find the lesson
    const lesson = await lessonsCollection.findOne({ _id: lessonId });

    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found" });
    }

    // Check if user already liked
    const hasLiked = lesson.likes && lesson.likes.includes(userEmail);

    if (hasLiked) {
      // Unlike: Remove user from likes array
      await lessonsCollection.updateOne(
        { _id: lessonId },
        {
          $pull: { likes: userEmail },
          $inc: { likesCount: -1 },
        }
      );
      res.json({ message: "Lesson unliked", liked: false });
    } else {
      // Like: Add user to likes array
      await lessonsCollection.updateOne(
        { _id: lessonId },
        {
          $addToSet: { likes: userEmail },
          $inc: { likesCount: 1 },
        }
      );
      res.json({ message: "Lesson liked", liked: true });
    }
  } catch (error) {
    console.error("Error toggling like:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update a lesson (creator only)
app.patch("/api/lessons/:id", verifyToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const lessonsCollection = getLessonsCollection();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const lessonId = new ObjectId(req.params.id);

    // Find the lesson
    const lesson = await lessonsCollection.findOne({ _id: lessonId });

    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found" });
    }

    // Check if user is the creator OR admin
    const isCreator = lesson.creatorEmail === req.user.email;
    const isAdmin = req.user.role === "admin";

    if (!isCreator && !isAdmin) {
      return res
        .status(403)
        .json({ error: "You can only update your own lessons" });
    }

    // Build update object with allowed fields
    const {
      title,
      description,
      category,
      emotionalTone,
      image,
      visibility,
      accessLevel,
    } = req.body;
    const updateFields = {};

    if (title) updateFields.title = title;
    if (description) updateFields.description = description;
    if (category) updateFields.category = category;
    if (emotionalTone) updateFields.emotionalTone = emotionalTone;
    if (image !== undefined) updateFields.image = image;
    if (visibility) updateFields.visibility = visibility;
    if (accessLevel) updateFields.accessLevel = accessLevel;

    // Admin only moderation flags
    if (isAdmin) {
      if (req.body.isFeatured !== undefined) updateFields.isFeatured = req.body.isFeatured;
      if (req.body.isReviewed !== undefined) updateFields.isReviewed = req.body.isReviewed;
    }

    // Check premium access for accessLevel
    if (accessLevel === "premium" && !req.user.isPremium) {
      return res
        .status(403)
        .json({ error: "Only premium users can create premium lessons" });
    }

    // Update the lesson
    await lessonsCollection.updateOne(
      { _id: lessonId },
      { $set: updateFields }
    );

    res.json({ message: "Lesson updated successfully" });
  } catch (error) {
    console.error("Error updating lesson:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a lesson (creator only)
app.delete("/api/lessons/:id", verifyToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const lessonsCollection = getLessonsCollection();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const lessonId = new ObjectId(req.params.id);

    // Find the lesson
    const lesson = await lessonsCollection.findOne({ _id: lessonId });

    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found" });
    }

    // Check if user is the creator OR admin
    const isCreator = lesson.creatorEmail === req.user.email;
    const isAdmin = req.user.role === "admin";

    if (!isCreator && !isAdmin) {
      return res
        .status(403)
        .json({ error: "You can only delete your own lessons" });
    }

    // Delete the lesson
    await lessonsCollection.deleteOne({ _id: lessonId });

    res.json({ message: "Lesson deleted successfully" });
  } catch (error) {
    console.error("Error deleting lesson:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Toggle favorite (add/remove)
app.post("/api/lessons/:id/favorite", verifyToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const lessonsCollection = getLessonsCollection();
    const favoritesCollection = getFavoritesCollection();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const lessonId = new ObjectId(req.params.id);
    const userEmail = req.user.email;

    // Check if lesson exists
    const lesson = await lessonsCollection.findOne({ _id: lessonId });
    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found" });
    }

    // Check if already favorited
    const existingFavorite = await favoritesCollection.findOne({
      userEmail: userEmail,
      lessonId: lessonId
    });

    if (existingFavorite) {
      // Remove from favorites collection
      await favoritesCollection.deleteOne({ _id: existingFavorite._id });

      // Remove from User profile (Legacy/Backup support)
      await getUsersCollection().updateOne(
        { email: userEmail },
        { $pull: { favorites: req.params.id } }
      );

      res.json({ message: "Removed from favorites", favorited: false });
    } else {
      // Add to favorites collection
      await favoritesCollection.insertOne({
        userEmail: userEmail,
        lessonId: lessonId,
        createdAt: new Date()
      });

      // Add to User profile (Legacy/Backup support)
      await getUsersCollection().updateOne(
        { email: userEmail },
        { $addToSet: { favorites: req.params.id } }
      );

      res.json({ message: "Added to favorites", favorited: true });
    }
  } catch (error) {
    console.error("Error toggling favorite:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get all comments for a lesson
app.get("/api/lessons/:id/comments", async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const commentsCollection = getCommentsCollection();

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    const lessonId = new ObjectId(req.params.id);
    const comments = await commentsCollection
      .find({ lessonId: lessonId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(comments);
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Post a comment (User)
app.post("/api/lessons/:id/comments", verifyToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const { text } = req.body;
    const commentsCollection = getCommentsCollection();
    const usersCollection = getUsersCollection();

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid lesson ID" });
    }

    if (!text || text.trim() === "") {
      return res.status(400).json({ error: "Comment text is required" });
    }

    const lessonId = new ObjectId(req.params.id);
    const user = await usersCollection.findOne({ email: req.user.email });

    const newComment = {
      lessonId: lessonId,
      userEmail: req.user.email,
      userName: user ? user.name : "Anonymous",
      userPhoto: user ? user.photo : "",
      text: text,
      createdAt: new Date(),
    };

    const result = await commentsCollection.insertOne(newComment);
    newComment._id = result.insertedId;

    res.status(201).json(newComment);
  } catch (error) {
    console.error("Error posting comment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get user's favorite lessons (with aggregation for filtering)
app.get("/api/my-favorites", verifyToken, async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const favoritesCollection = getFavoritesCollection();
    // No need to fetch Users/Lessons separately, we use aggregation

    const { category, emotionalTone } = req.query;

    const pipeline = [
      // 1. Match favorites for this user
      { $match: { userEmail: req.user.email } },

      // 2. Lookup the actual lesson details
      {
        $lookup: {
          from: "lessons",
          localField: "lessonId",
          foreignField: "_id",
          as: "lesson"
        }
      },

      // 3. Unwind the lesson array (since lookup returns an array)
      { $unwind: "$lesson" },

      // 4. Project the lesson fields to root (optional, or keep inside 'lesson')
      // We will replace root with lesson but keep favorite metadata if needed. 
      // For simplicity matching the previous API, we return the lessons.
      {
        $replaceRoot: { newRoot: "$lesson" }
      }
    ];

    // 5. Apply filters on the LESSON fields
    if (category) {
      pipeline.push({ $match: { category: category } });
    }
    if (emotionalTone) {
      pipeline.push({ $match: { emotionalTone: emotionalTone } });
    }

    // Sort by added time? Or lesson creation? 
    // Requirement says "display tabular format", existing code sorted by createdAt.
    // Since we replaced root with lesson, 'createdAt' is the lesson's date.
    // If we want favorited date, we'd need to keep it before replaceRoot.
    // Let's stick to lesson properties for filters/sort as requested.

    // Execute aggregation
    const favoriteLessons = await favoritesCollection.aggregate(pipeline).toArray();

    res.json({
      lessons: favoriteLessons,
      total: favoriteLessons.length,
    });
  } catch (error) {
    console.error("Error fetching favorites:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server after DB connection
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Rewise server is running on port ${PORT}`);
  });
});

module.exports = app;
