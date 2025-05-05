# LearnQuest Express Server

This is the backend server for the **LearnQuest** educational game. It provides REST APIs and WebSocket support for real-time chat, course progression, AI assistance, and user data handling.

---

## 🚀 Features

- Express.js RESTful APIs
- WebSocket-based real-time chat
- Firebase Firestore for user data and game state
- OpenAI integration for chat moderation and AI assistance
- AstraDB vector store for RAG (Retrieval-Augmented Generation)
- User authentication and inventory systems

---

## 🛠️ Setup Instructions

### 1. Clone the Repository

```
git clone https://github.com/your-org/learnquest-server.git
cd learnquest-server
```

### 2. Install Dependencies

```
npm install
```

### 3. Create a `.env` File

Add a `.env` file in the root of your project with the following environment variables:

```
PORT=5001

FIREBASE_PROJECT_ID=your_project_id
FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account", ...}  # Escape double quotes or use JSON.parse as shown in code

OPENAI_API_KEY=your_openai_api_key

ASTRA_DB_APPLICATION_TOKEN=your_astra_token
ASTRA_DB_API_ENDPOINT=https://your-astra-db-id-us-east1.apps.astra.datastax.com
```

You can securely store and load your Firebase service account key using a single stringified JSON object via `FIREBASE_SERVICE_ACCOUNT_KEY`.

---

## 🧪 Running Locally

```
npm start
```

The server should start at `http://localhost:5001`.

---

## 📡 WebSocket Endpoint

Connect to WebSocket on:

```
ws://localhost:5001
```

---

## 🧪 Testing the API

You can test the API using:

- **Postman** or **Insomnia**: Import your endpoints and make HTTP requests.
- **Browser**: For `GET` routes like `/leaderboard`, you can directly visit them.
- **WebSocket clients**: Tools like [websocat](https://github.com/vi/websocat) or browser clients to test message formats (`join`, `chat`, `rag-chat`, etc.).

---

## 🔍 Important Endpoints

### Auth & User

- `POST /register`
- `POST /login`
- `GET /leaderboard`
- `GET /user-items/:username`

### Courses & Progress

- `POST /start-course`
- `POST /start-level`
- `POST /update-level`
- `GET /get-objectives/:username/:level_name`
- `GET /course-structure/:username/:course_name`

### Chat (WebSocket)

- `type: 'join'`, `chat`, `leave`, `rag-chat`
- AI moderation and vector search built-in

---

## 🧹 Notes

- Ensure Firestore and AstraDB are properly configured.
- RAG features require a valid OpenAI key and Astra vector store.
