# Rewise Server (Backend)

The centralized backend server for the **Rewise** platform ("Digital Life Lessons"). Built with Node.js, Express, and MongoDB Native Driver, providing secure API endpoints for user management, lesson content, content moderation, and payment processing.

🔗 **Live Server URL:** [https://rewise-server.vercel.app](https://rewise-server.vercel.app)

---

## 🛠️ Tech Stack & Features

### Core Technologies
*   **Runtime:** Node.js
*   **Framework:** Express.js
*   **Database:** MongoDB (Native Driver - No Mongoose)
*   **Authentication:** Firebase Admin SDK (JWT Verification)
*   **Payments:** Stripe (Checkout Sessions & Webhooks)

### Key Features
1.  **Secure Authentication**
    *   Strict Middleware (`verifyToken`) validating Firebase ID Tokens.
    *   **User Sync:** Explicit synchronization endpoint (`POST /api/users`) to map Firebase users to MongoDB.
    *   **Role-Based Access:** Admin-only routes protected by `verifyAdmin`.

2.  **Lesson Management**
    *   **Public API:** filtering by Category, Emotion, Search (Regex).
    *   **Private Visiblity:** Creators/Admins can view private drafts; locked for others.
    *   **Premium Access:** Gated content checking `isPremium` user status.

3.  **Advanced Interactions**
    *   **Dual-Store Favorites:** Favorites stored in both `User.favorites` (array) and `Favorites` (collection) for redundancy and aggregation filtering.
    *   **Reporting System:** Users can report content; Admins see aggregated reports with populated lesson details.
    *   **Engagement:** Like/Unlike counts and comments system.

---

## 🚀 Installation & Setup

### 1. Clone & Install
```bash
git clone <repository_url>
cd server
npm install
```

### 2. Environment Variables
Create a `.env` file in the root directory:

```env
# Server
PORT=5000

# Database
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/rewise?retryWrites=true&w=majority

# Firebase Admin SDK (From Service Account JSON)
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
CLIENT_URL=http://localhost:5173 
```

### 3. Run Locally
```bash
# Start development server (using nodemon)
npm run dev

# Start production server
node index.js
```

---

## 📡 API Overview

### Authentication
*   `POST /api/users/:email` - **Sync User** (Call immediately after Firebase Login).
*   `GET /api/user/me` - Get current user profile.

### Lessons
*   `GET /api/lessons` - Public list (Supports `?search=`, `?category=`, `?featured=true`, `?creatorEmail=`).
*   `GET /api/lessons/:id` - Single lesson details (with Auth/Premium checks).
*   `POST /api/lessons` - Create a lesson.
*   `PATCH /api/lessons/:id` - Update lesson (Creator/Admin).
*   `DELETE /api/lessons/:id` - Delete lesson.

### User Actions
*   `GET /api/my-lessons` - List user's created lessons.
*   `GET /api/my-favorites` - List favorited lessons (Filtered).
*   `POST /api/lessons/:id/favorite` - Toggle favorite.
*   `POST /api/lessons/:id/like` - Toggle like.
*   `POST /api/lessons/:id/comments` - Post a comment.

### Admin Dashboard
*   `GET /api/admin/stats` - System-wide statistics.
*   `GET /api/admin/users` - Manage users.
*   `GET /api/admin/reports` - View reported content (Detailed).

### Payments
*   `POST /api/create-checkout-session` - Initialize Stripe payment.
*   `POST /api/stripe/webhook` - Handle payment success events.

---

## 🔒 Security Measures
*   **JWT Verification:** All protected routes verify the Bearer token against Firebase Auth.
*   **Role Validation:** Admin routes explicitly check `user.role === 'admin'` in MongoDB.
*   **Stripe Webhooks:** Signature verification ensures payment events are genuine.
*   **CORS:** Configured for trusted frontend domains.

---

## 📜 License
This project is open-source and available under the [MIT License](LICENSE).

---
*Developed by Mujahidul Islam Arif*
