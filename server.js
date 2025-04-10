require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const http = require("http"); // native Node HTTP
const bcrypt = require("bcrypt");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(bodyParser.json());
const server = http.createServer(app); // pass Express to HTTP

const PORT = process.env.PORT || 5001;


// Required for WebSocket chat functionality
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai');
const { DataAPIClient } = require("@datastax/astra-db-ts");

// Initialize vector store
let vectorStore = null;

// Initialize OpenAI for message moderation
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Add this to your .env file
});

// Track connected clients by course_id
const courseClients = {};
const wss = new WebSocket.Server({ server }); // attach WebSocket to same server
// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection established');
    
    // Initial connection has no course_id until joinCourse is called
    let userData = { 
        id: uuidv4(),
        username: null,
        course_id: null
    };
    
    ws.userData = userData;
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'join':
                    // Join a course chat room
                    handleJoinCourse(ws, data);
                    break;
                    
                case 'chat':
                    // Submit a chat message (goes through moderation)
                    await handleChatMessage(ws, data);
                    break;
                    
                case 'delete':
                    // Delete a chat message
                    await handleDeleteMessage(ws, data);
                    break;
                    
                case 'leave':
                    // Leave a course chat room
                    handleLeaveCourse(ws);
                    break;
                case 'rag-chat':
                    await handleRagChatMessage(ws, data);
                    break;
                    
                    
                default:
                    console.log(`Unknown message type: ${data.type}`);
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to process message'
            }));
        }
    });
    
    ws.on('close', () => {
        console.log(`WebSocket connection closed for client ${userData.id}`);
        handleLeaveCourse(ws);
    });
});

// Function to initialize the vector store
async function initVectorStore() {
    try {
      console.log("Initializing AstraDB vector store...");
      
      // Use the DataAPIClient from @datastax/astra-db-ts
      const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
      const db = client.db(process.env.ASTRA_DB_API_ENDPOINT);
      
      // Create or get the collection
      vectorStore = await db.collection("ragchatbot");
      
      console.log("Vector store initialized successfully");
      return true;
    } catch (error) {
      console.error("Error initializing vector store:", error);
      return false;
    }
}

// Function to generate embeddings using OpenAI
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text
  });
  return response.data[0].embedding;
}

//extract search query keywords for embedding from user query
async function extractKeywordsForEmbedding(userQuery) {
    try {
        const prompt = `
        You are an assistant that rewrites user questions into clean, focused technical search queries for a programming education game.
        
        Your job is to:
        - Remove filler words and casual phrasing
        - Focus the query on technical concepts relevant to HTML, CSS, JavaScript, or programming
        - Use as few words as possible to capture the essential meaning
        - Output the search query as a short, lowercase phrase (not a full sentence)
        - If the user input is a greeting or unrelated to programming, return exactly: greeting
        
        User input: "${userQuery}"
        
        Vector search query:
        `;
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo", // Using a smaller model for efficiency
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 60
      });
      
      const extractedKeywords = response.choices[0].message.content.trim();
      console.log(`Original query: "${userQuery}"`);
      console.log(`Extracted keywords: "${extractedKeywords}"`);
      
      // If we just got "greeting" back, we'll use a default query for general info
      if (extractedKeywords.toLowerCase() === "greeting") {
        return "LearnQuest game overview information";
      }
      
      return extractedKeywords;
    } catch (error) {
      console.error("Error extracting keywords:", error);
      // Fallback to original query if extraction fails
      return userQuery;
    }
  }
  

  // Function to generate embeddings using OpenAI
async function handleRagChatMessage(ws, data) {
    const { message, username } = data;
    
    if (!username) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'You must be logged in to use the chat assistant'
        }));
        return;
    }
    
    if (!message || message.trim() === '') {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Message cannot be empty'
        }));
        return;
    }
    
    try {
        // Check if vector store is initialized
        if (!vectorStore) {
            // Try to initialize it
            const initialized = await initVectorStore();
            if (!initialized) {
                throw new Error("Vector store is not available");
            }
        }
        
        // Extract keywords for better search
        const searchQuery = await extractKeywordsForEmbedding(message);

        // Generate embedding for the query
        const queryEmbedding = await generateEmbedding(searchQuery);
        
        // Search vector store using the embedding
        const cursor = await vectorStore.find(
            {}, // Empty filter object since we're using vector search
            { 
              sort: { $vector: queryEmbedding }, // Use the embedding in sort with $vector
              limit: 3,
              includeSimilarity: true // Include similarity scores in results
            }
          );

        // Collect documents from cursor
        const documents = [];
        for await (const doc of cursor) {
            documents.push(doc);
        }
        
        // Extract context from documents
        let contexts = [];
        if (documents.length > 0) {
            contexts = documents.map(doc => {
                return doc.page_content;
            });
        } else {
            console.log("No relevant documents found");
            contexts = ["No relevant information found"];
        }
        
        const combinedContext = contexts.join("\n\n");
     
        console.log("Combined context for OpenAI:", combinedContext);
        const prompt = `
            You are a helpful and friendly AI assistant in a programming-based educational game called *LearnQuest*.

            Use the provided context to help the player answer their question. If the question isn't directly answered, but the context includes related examples or explanations, do your best to explain it using that information.

            If the question is a greeting, thank-you, or goodbye, respond appropriately.

            If the message is game-related and the answer truly cannot be inferred from the context, reply:
            "I’m not sure based on the current information."

            ---
            Context:
            ${combinedContext}

            ---
            User Message:
            ${message}

            ---
            Answer:
            `;


        
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
        });
        
        const assistantResponse = response.choices[0].message.content;
        
        // Step 3: Save to database for history
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const messageId = uuidv4();
        
        await db.collection("rag_chat_messages").add({
            id: messageId,
            username,
            user_message: message,
            assistant_response: assistantResponse,
            timestamp
        });
        
        // Step 4: Send response back to user
        ws.send(JSON.stringify({
            type: 'rag-response',
            id: messageId,
            message: assistantResponse,
            timestamp: new Date().toISOString()
        }));
        
    } catch (error) {
        console.error('Error in RAG chat:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to process your question'
        }));
    }
}

// Handle message deletion
async function handleDeleteMessage(ws, data) {
    const { message_id } = data;
    const { username, course_id } = ws.userData;
    
    if (!username || !course_id) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'You must join a course chat first'
        }));
        return;
    }
    
    if (!message_id) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Message ID is required'
        }));
        return;
    }
    
    try {
        // Step 1: Find the message in the chat_messages collection
        console.log(`Finding message with ID: ${message_id}`);
        const messageRef = db.collection("chat_messages")
            .where("id", "==", message_id)
            .where("course_id", "==", course_id);
            
        const messageSnapshot = await messageRef.get();
        
        if (messageSnapshot.empty) {
            console.log(`Message not found: ${message_id}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Message not found'
            }));
            return;
        }
        
        const messageDoc = messageSnapshot.docs[0];
        const messageData = messageDoc.data();
        
        // Step 2: Check if the user is the owner of the message
        if (messageData.username !== username) {
            console.log(`User ${username} is not authorized to delete message: ${message_id}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'You can only delete your own messages'
            }));
            return;
        }
        
        // Step 3: Delete the message
        await db.collection("chat_messages").doc(messageDoc.id).delete();
        console.log(`Message ${message_id} deleted by user: ${username}`);
        
        // Step 4: Notify the user that the message was deleted
        ws.send(JSON.stringify({
            type: 'delete-confirmed',
            message_id: message_id
        }));
        
        // Step 5: Broadcast to all users in the course that a message was deleted
        broadcastMessage(course_id, {
            type: 'message-deleted',
            message_id: message_id
        });
        
    } catch (error) {
        console.error('Error deleting message:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to delete message'
        }));
    }
}

// Get RAG chat history for a specific user
app.get("/rag-chat-history/:username", async (req, res) => {
    const { username } = req.params;
    console.log(`Getting RAG chat history for user: ${username}`);
    
    try {
        // Query the rag_chat_messages collection for this user
        const messagesRef = db.collection("rag_chat_messages")
            .where("username", "==", username)
            .orderBy("timestamp", "desc")
            .limit(50);
            
        const snapshot = await messagesRef.get();
        
        if (snapshot.empty) {
            console.log(`No RAG chat history found for user: ${username}`);
            return res.status(200).json({ messages: [] });
        }
        
        const messages = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            messages.push({
                id: data.id,
                user_message: data.user_message,
                assistant_response: data.assistant_response,
                timestamp: data.timestamp.toDate().toISOString()
            });
        });
        
        console.log(`Returning ${messages.length} RAG chat messages for user: ${username}`);
        res.status(200).json({ messages: messages.reverse() });
    } catch (error) {
        console.error("Error getting RAG chat history:", error);
        res.status(500).json({ error: error.message });
    }
});

// Handle course join request
function handleJoinCourse(ws, data) {
    const { username, course_id } = data;
    
    if (!username || !course_id) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Username and course_id are required'
        }));
        return;
    }
    
    // Remove from previous course if any
    if (ws.userData.course_id) {
        handleLeaveCourse(ws);
    }
    
    // Update user data
    ws.userData.username = username;
    ws.userData.course_id = course_id;
    
    // Add to course clients
    if (!courseClients[course_id]) {
        courseClients[course_id] = new Set();
    }
    courseClients[course_id].add(ws);
    
    console.log(`User ${username} joined course chat: ${course_id}`);
    
    // Send confirmation
    ws.send(JSON.stringify({
        type: 'joined',
        course_id,
        message: `You've joined the chat for course: ${course_id}`
    }));
    
    // Send recent messages
    sendRecentMessages(ws, course_id);
}

// Handle chat message submission and moderation
async function handleChatMessage(ws, data) {
    const { message } = data;
    const { username, course_id } = ws.userData;
    
    if (!username || !course_id) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'You must join a course chat first'
        }));
        return;
    }
    
    if (!message || message.trim() === '') {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Message cannot be empty'
        }));
        return;
    }
    
    // Send acknowledgment that message is being moderated
    ws.send(JSON.stringify({
        type: 'moderation-start',
        message: 'Your message is being reviewed...'
    }));
    
    try {
        // Step 1: Get course information for context
        const courseRef = db.collection("courses").where("course_name", "==", course_id);
        const courseSnapshot = await courseRef.get();
        
        if (courseSnapshot.empty) {
            throw new Error("Course not found");
        }
        
        const courseData = courseSnapshot.docs[0].data();
        
        // Step 2: Use OpenAI to moderate the message
        const isRelevant = await moderateMessage(message, courseData);
        
        if (isRelevant) {
            // Message passed moderation
            const timestamp = admin.firestore.FieldValue.serverTimestamp();
            const messageId = uuidv4();
            
            // Save to database
            await db.collection("chat_messages").add({
                id: messageId,
                course_id,
                username,
                message,
                timestamp,
                moderated: true
            });
            
            // Notify user their message was approved
            ws.send(JSON.stringify({
                type: 'moderation-approved',
                message: 'Your message has been approved and posted'
            }));
            
            // Broadcast to all users in this course
            broadcastMessage(course_id, {
                type: 'chat',
                id: messageId,
                username,
                message,
                timestamp: new Date().toISOString() // Use client-side timestamp for immediate display
            }, ws.userData.id);
            
        } else {
            // Message rejected
            await db.collection("message_queue").add({
                course_id,
                username,
                message,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: "rejected",
                rejection_reason: "Message not relevant to course content"
            });
            
            ws.send(JSON.stringify({
                type: 'moderation-rejected',
                message: 'Your message was rejected as it does not appear to be relevant to the course content.'
            }));
        }
        
    } catch (error) {
        console.error('Error processing chat message:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to process your message'
        }));
    }
}

// Moderate a message using OpenAI
async function moderateMessage(message, courseData) {
    try {
        const prompt = `
            You are moderating chat messages for an educational app.

            Course: ${courseData.course_name}
            
            Message: "${message}"
            
            Is this message related to learning, teaching, education, or asking for help?
            Answer only with "yes" or "no".
        `;
        
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 5,
            temperature: 0.1
        });
        
        const answer = response.choices[0].message.content.toLowerCase();
        return answer.includes('yes');
        
    } catch (error) {
        console.error('Error in message moderation:', error);
        
        // For production, add fallback moderation if API fails
        // For now, default to letting messages through if moderation fails
        return true;
    }
}

// Handle course leave request
function handleLeaveCourse(ws) {
    const { course_id, id } = ws.userData;
    
    if (course_id && courseClients[course_id]) {
        courseClients[course_id].delete(ws);
        
        // Clean up empty course rooms
        if (courseClients[course_id].size === 0) {
            delete courseClients[course_id];
        }
        
        console.log(`User left course chat: ${course_id}`);
    }
    
    // Reset user data
    ws.userData.course_id = null;
}

// Broadcast message to all clients in a course
function broadcastMessage(course_id, message, excludeClientId = null) {
    if (!courseClients[course_id]) return;
    
    courseClients[course_id].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Send recent messages to a client
async function sendRecentMessages(ws, course_id) {
    try {
        const messagesRef = db.collection("chat_messages")
            .where("course_id", "==", course_id)
            .where("moderated", "==", true)
            .orderBy("timestamp", "desc")
            .limit(50);
            
        const snapshot = await messagesRef.get();
        
        const messages = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            messages.push({
                id: data.id,
                username: data.username,
                message: data.message,
                timestamp: data.timestamp.toDate().toISOString()
            });
        });
        
        // Send history to client
        ws.send(JSON.stringify({
            type: 'history',
            messages: messages.reverse() // Send in chronological order
        }));
        
    } catch (error) {
        console.error('Error fetching chat history:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to load chat history'
        }));
    }
}

// REST API endpoint to get recent chat messages (for initial load without WebSocket)
app.get("/chat-messages/:course_id", async (req, res) => {
    const { course_id } = req.params;
    
    try {
        const messagesRef = db.collection("chat_messages")
            .where("course_id", "==", course_id)
            .where("moderated", "==", true)
            .orderBy("timestamp", "desc")
            .limit(50);
            
        const snapshot = await messagesRef.get();
        
        const messages = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            messages.push({
                id: data.id,
                username: data.username,
                message: data.message,
                timestamp: data.timestamp.toDate().toISOString()
            });
        });
        
        res.status(200).json({ messages: messages.reverse() });
    } catch (error) {
        console.error("Error getting chat messages:", error);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Register API (User Signup)
app.post("/register", async (req, res) => {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
        return res.status(400).json({ error: "Email, username, and password required" });
    }

    try {
        // Check if email already exists
        const emailRef = db.collection("users").doc(email);
        const emailDoc = await emailRef.get();
        if (emailDoc.exists) {
            return res.status(400).json({ error: "Email already registered" });
        }

        // Check if username already exists
        const usernameQuery = await db.collection("users").where("username", "==", username).get();
        if (!usernameQuery.empty) {
            return res.status(400).json({ error: "Username already taken" });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Save user to Firestore
        await emailRef.set({
            email,
            username,
            password: hashedPassword,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            score: 0, // Default score for new users
            bestTime: 0,
            numAchievements: 0,
            numGems: 0
        });

        // Add default items to user inventory
        console.log(`Finding default items for new user: ${username}`);
        const defaultItemsRef = db.collection("item").where("default", "==", true);
        const defaultItemsSnapshot = await defaultItemsRef.get();
        
        if (!defaultItemsSnapshot.empty) {
            console.log(`Found ${defaultItemsSnapshot.size} default items to add to user's inventory`);
            const itemPromises = [];
            defaultItemsSnapshot.forEach(doc => {
                const itemData = doc.data();
                itemPromises.push(
                    db.collection("user_items").add({
                        username,
                        item_name: itemData.item_name,
                        item_type: itemData.item_type
                    })
                );
            });
            await Promise.all(itemPromises);
            console.log(`Successfully added ${itemPromises.length} default items to user: ${username}`);
        } else {
            console.log("No default items found to add to new user");
        }

        res.status(201).json({ 
            message: "User registered successfully",
            default_items_added: defaultItemsSnapshot.size || 0,
        });
    } catch (error) {
        console.error("Error in register endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Get leaderboard rankings
app.get("/leaderboard", async (req, res) => {
    console.log("Getting leaderboard rankings");

    try {
        // Step 1: Query the users collection
        console.log("Querying users collection for leaderboard data");
        const usersRef = db.collection("users");
        const usersSnapshot = await usersRef.get();
        
        if (usersSnapshot.empty) {
            console.log("No users found");
            return res.status(404).json({ error: "No users found" });
        }

        // Step 2: Extract and format user data
        let leaderboardData = [];
        
        usersSnapshot.forEach(doc => {
            const userData = doc.data();
            
            // Only include necessary fields for the leaderboard
            leaderboardData.push({
                username: userData.username,
                score: userData.score || 0, 
                numAchievements: userData.numAchievements || 0,
                numGems: userData.numGems || 0
            });
        });

        
        console.log(`Returning leaderboard with ${leaderboardData.length} users`);
        res.status(200).json(leaderboardData);
    } catch (error) {
        console.error("Error in leaderboard endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Get achievements for a user filtered by course
app.get("/get-achievements/:username/:course_name?", async (req, res) => {
    const { username, course_name } = req.params;
    console.log(`Getting achievements for user: ${username}${course_name ? `, course: ${course_name}` : ''}`);

    try {
        // Step 1a: If course_name provided, find the course ID
        let course_id = null;
        if (course_name) {
            console.log(`Finding course ID for course: ${course_name}`);
            const courseRef = db.collection("courses").where("course_name", "==", course_name);
            const courseSnapshot = await courseRef.get();

            if (courseSnapshot.empty) {
                console.log(`Course not found: ${course_name}`);
                return res.status(404).json({ error: "Course not found" });
            }

            course_id = courseSnapshot.docs[0].data().course_id;
            console.log(`Found course ID: ${course_id}`);
        }

        // Step 1b: Query user_achievements for the given username
        console.log("Querying user_achievements collection");
        const userAchievementsRef = db.collection("user_achievements").where("username", "==", username);
        const userAchievementsSnapshot = await userAchievementsRef.get();

        if (userAchievementsSnapshot.empty) {
            console.log(`No achievements found for user: ${username}`);
            return res.status(404).json({ error: "No achievements found for this user" });
        }

        // Step 2: Prepare to fetch achievement details from the achievement collection
        console.log("Fetching achievement details from the achievement collection");
        const achievements = [];
        const achievementPromises = [];
        const achievementNames = [];

        userAchievementsSnapshot.forEach(doc => {
            const userAchievementData = doc.data();
            achievementNames.push(userAchievementData.achievement_name);
        });

        // Step 3: Get all achievement details in one batch query
        const achievementDetailsRef = db.collection("achievement");
        let achievementDetailsQuery = achievementDetailsRef;
        
        // If course_id is provided, filter by course
        if (course_id) {
            achievementDetailsQuery = achievementDetailsRef.where("course_id", "==", course_id);
        }
        
        const achievementDetailsSnapshot = await achievementDetailsQuery.get();

        // Create a map for quick lookups
        const achievementDetailsMap = {};
        achievementDetailsSnapshot.forEach(doc => {
            const data = doc.data();
            achievementDetailsMap[data.achievement_name] = data;
        });

        // Step 4: Process user achievements
        for (const doc of userAchievementsSnapshot.docs) {
            const userAchievementData = doc.data();
            const achievement_name = userAchievementData.achievement_name;
            
            // If filtering by course, only include achievements for this course
            const achievementDetails = achievementDetailsMap[achievement_name];
            if (achievementDetails) {
                if (!course_id || achievementDetails.course_id === course_id) {
                    achievements.push({
                        achievement_name: achievement_name,
                        description: achievementDetails.description || "No description available",
                        gems: achievementDetails.gems || 0,
                        status: userAchievementData.status,
                    });
                }
            }
        }

        console.log(`Returning ${achievements.length} achievements for user: ${username}`);
        res.status(200).json({ achievements });
    } catch (error) {
        console.error("Error in get-achievements endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});


// 📌 Start a level for a user
app.post("/start-level", async (req, res) => {
    const { username, level_name } = req.body;
    console.log(`Starting level: ${level_name} for user: ${username}`);

    if (!username || !level_name) {
        return res.status(400).json({ error: "Username and level name are required" });
    }

    try {
        // Step 1: Find all objectives for this level
        console.log(`Step 1: Finding objectives for level: ${level_name}`);
        const objectivesRef = db.collection("objective").where("level_name", "==", level_name);
        const objectivesSnapshot = await objectivesRef.get();

        if (objectivesSnapshot.empty) {
            console.log(`No objectives found for level: ${level_name}`);
            return res.status(404).json({ error: "No objectives found for this level" });
        }

        console.log(`Found ${objectivesSnapshot.size} objectives for level: ${level_name}`);

         // Step 2: Check if user has already started this level
        console.log("Step 2: Checking if user has already started any objectives for this level");
        const existingUserObjectivesRef = db.collection("user_objectives")
            .where("username", "==", username)
            .where("level_name", "==", level_name);
        
        const existingUserObjectives = await existingUserObjectivesRef.get();
        
        if (!existingUserObjectives.empty) {
            console.log(`User ${username} has already started level: ${level_name}`);
            return res.status(200).json({ 
                message: "Level already started", 
                objectives_count: existingUserObjectives.size
            });
        }

        // Step 3: Create entries in user_objectives collection for each objective
        console.log(`Step 3: Creating user objective entries for level: ${level_name}`);
        const userObjectivePromises = [];
      
        for (const objectiveDoc of objectivesSnapshot.docs) {
            const objectiveData = objectiveDoc.data();
            const objective_name = objectiveData.objective_name;
            
            console.log(`Adding objective: ${objective_name} for user: ${username}`);
            
            userObjectivePromises.push(
                db.collection("user_objectives").add({
                    username,
                    objective_name,
                    status: "not completed",
                    level_name: level_name
                })
            );
        }

        // Execute all database operations
        console.log(`Executing ${userObjectivePromises.length} objective operations`);
        await Promise.all(userObjectivePromises);
        console.log("All objectives added successfully");


        res.status(201).json({
            message: "Level started successfully",
        });
        
    } catch (error) {
        console.error("Error in start-level endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});


// 📌 Get all items grouped by item_type
app.get("/items", async (req, res) => {
    console.log("Getting all items grouped by item_type");
    
    try {
        // Query the items collection
        const itemsRef = db.collection("item");
        const snapshot = await itemsRef.get();
        
        if (snapshot.empty) {
            console.log("No items found");
            return res.status(404).json({ error: "No items found" });
        }

        // Extract data from documents and group by item_type
        const itemsByType = {};
        
        snapshot.forEach(doc => {
            const itemData = doc.data();
            const item_type = itemData.item_type || "uncategorized";
            const item = {
                id: doc.id,
                item_name: itemData.item_name,
                cost: itemData.cost || 0,
                // You can include other item details here if needed
            };
            
            // Create the type group if it doesn't exist yet
            if (!itemsByType[item_type]) {
                itemsByType[item_type] = [];
            }
            
            // Add this item to its type group
            itemsByType[item_type].push(item);
        });
        
        // Count total items
        let totalItems = 0;
        Object.values(itemsByType).forEach(items => {
            totalItems += items.length;
        });
        
        console.log(`Returning ${totalItems} items grouped into ${Object.keys(itemsByType).length} categories`);
        
        res.status(200).json({
            items: itemsByType
        });
        
    } catch (error) {
        console.error("Error getting items:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Get objectives for a user's level
app.get("/get-objectives/:username/:level_name", async (req, res) => {
    const { username, level_name } = req.params;
    console.log(`Getting objectives for user: ${username}, level: ${level_name}`);

    try {
        // Step 1: Query user_objectives for this user and level
        console.log(`Step 1: Finding user objectives for level: ${level_name}`);
        const userObjectivesRef = db.collection("user_objectives")
            .where("username", "==", username)
            .where("level_name", "==", level_name);
        
        const userObjectivesSnapshot = await userObjectivesRef.get();

        if (userObjectivesSnapshot.empty) {
            console.log(`No objectives found for user: ${username} and level: ${level_name}`);
            return res.status(404).json({ 
                error: "No objectives found for this user and level",
                message: "Level may not have been started"
            });
        }

        console.log(`Found ${userObjectivesSnapshot.size} objectives for level: ${level_name}`);

        // Step 2: Extract objective data and enhance with details from objectives collection
        const objectives = [];
        const objectivePromises = [];
        
        for (const doc of userObjectivesSnapshot.docs) {
            const userObjectiveData = doc.data();
            const objective_name = userObjectiveData.objective_name;
            
            // Find the objective details in the objectives collection
            const objectiveDetailsPromise = db.collection("objective")
                .where("objective_name", "==", objective_name)
                .where("level_name", "==", level_name)
                .get()
                .then(detailsSnapshot => {
                    let objectiveDetails = {};
                    
                    if (!detailsSnapshot.empty) {
                        objectiveDetails = detailsSnapshot.docs[0].data();
                    }
                    
                    // Combine user objective status with details from objectives collection
                    objectives.push({
                        objective_name: objective_name,
                        status: userObjectiveData.status,
                        description: objectiveDetails.description || "No description available",
                        difficulty: objectiveDetails.difficulty || "medium",
                        points: objectiveDetails.points || 0,
                        order: objectiveDetails.order || 0,
                    });
                });
                
            objectivePromises.push(objectiveDetailsPromise);
        }
        
        // Wait for all objective detail lookups to complete
        await Promise.all(objectivePromises);
        
        // Sort objectives by the order field
        objectives.sort((a, b) => a.order - b.order);
        
        res.status(200).json({
            objectives: objectives
        });
        
    } catch (error) {
        console.error("Error in get-objectives endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Update a user's score directly
app.post("/update-score", async (req, res) => {
    const { username, score } = req.body;
    console.log(`Updating score for user: ${username} to: ${score}`);

    if (!username || score === undefined) {
        return res.status(400).json({ error: "Username and score are required" });
    }

    // Convert score to number if it's a string
    const numericScore = Number(score);
    if (isNaN(numericScore)) {
        return res.status(400).json({ error: "Score must be a valid number" });
    }

    try {
        // Step 1: Find user in the users collection
        console.log(`Step 1: Finding user: ${username}`);
        const userRef = db.collection("users").where("username", "==", username);
        const userSnapshot = await userRef.get();

        if (userSnapshot.empty) {
            console.log(`User not found: ${username}`);
            return res.status(404).json({ error: "User not found" });
        }

        // Step 2: Update the user's score
        const userDoc = userSnapshot.docs[0];
        const userId = userDoc.id;
        const userData = userDoc.data();
        const currentScore = userData.score || 0;

        console.log(`Step 2: Updating score from ${currentScore} to ${numericScore}`);
        await db.collection("users").doc(userId).update({
            score: numericScore
        });

        console.log(`Successfully updated score for user: ${username}`);

        res.status(200).json({
            message: "User score updated successfully",
            username,
            previous_score: currentScore,
            new_score: numericScore
        });
    } catch (error) {
        console.error("Error in update-score endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Login API (User Authentication)
app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password required" });
    }

    try {
        // Find user by email
        const userRef = db.collection("users").doc(email);
        const doc = await userRef.get();

        if (!doc.exists) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const userData = doc.data();

        // Compare password
        const isMatch = await bcrypt.compare(password, userData.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Format createdAt timestamp if available
        let createdAt = userData.createdAt ? userData.createdAt.toDate().toISOString() : "Unknown";

        res.status(200).json({
            message: "Login successful",
            email: userData.email,
            username: userData.username,
            createdAt: createdAt,
            score: userData.score || 0,
            numGems: userData.numGems || 0,
            streak_counter: userData.streak_counter || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// 📌 Buy an item for a user
app.post("/buy-item", async (req, res) => {
    const { username, item_name, item_type } = req.body;
    console.log(`User ${username} is attempting to purchase ${item_name} of type ${item_type}`);

    if (!username || !item_name || !item_type) {
        return res.status(400).json({ error: "Username, item name, and item type are required" });
    }

    try {
        // Step 1: Check if the item exists
        console.log(`Step 1: Checking if item ${item_name} exists`);
        const itemRef = db.collection("item")
            .where("item_name", "==", item_name)
            .where("item_type", "==", item_type);
        
        const itemSnapshot = await itemRef.get();
        
        if (itemSnapshot.empty) {
            console.log(`Item not found: ${item_name} of type ${item_type}`);
            return res.status(404).json({ error: "Item not found" });
        }

        const itemData = itemSnapshot.docs[0].data();
        const itemCost = itemData.cost || 0;

        console.log(`Found item: ${item_name}, Cost: ${itemCost}`);

        // Step 2: Check if user has enough credits or gems
        console.log(`Step 2: Checking if user ${username} has enough credits or gems`);
        const userRef = db.collection("users").where("username", "==", username);
        const userSnapshot = await userRef.get();
        
        if (userSnapshot.empty) {
            console.log(`User not found: ${username}`);
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userSnapshot.docs[0].data();
        const userCredits = userData.score || 0;
        const userGems = userData.numGems || 0;

        if (item_type === "Boost" && userGems < itemCost) {
            console.log(`User ${username} has insufficient gems: ${userGems} < ${itemCost}`);
            return res.status(400).json({ error: "Insufficient gems" });
        } else if (item_type !== "Boost" && userCredits < itemCost) {
            console.log(`User ${username} has insufficient credits: ${userCredits} < ${itemCost}`);
            return res.status(400).json({ error: "Insufficient credits" });
        }

        // Step 3: Check if user already owns this item
        console.log(`Step 3: Checking if user already owns item ${item_name}`);
        const userItemRef = db.collection("user_items")
            .where("username", "==", username)
            .where("item_name", "==", item_name)
            .where("item_type", "==", item_type);
            
        const userItemSnapshot = await userItemRef.get();
        
        if (!userItemSnapshot.empty) {
            console.log(`User ${username} already owns item: ${item_name}`);
            return res.status(400).json({ error: "User already owns this item" });
        }

        // Step 4: Create a transaction to update user credits/gems and add item to user_items
        console.log(`Step 4: Processing purchase transaction`);
        const userDocRef = db.collection("users").doc(userSnapshot.docs[0].id);

        if (item_type === "Boost") {
            // Decrement gems for "Move" items
            await userDocRef.update({
                numGems: admin.firestore.FieldValue.increment(-itemCost)
            });
            console.log(`Updated user gems: ${userGems} -> ${userGems - itemCost}`);
        } else {
            // Decrement score for other items
            await userDocRef.update({
                score: admin.firestore.FieldValue.increment(-itemCost)
            });
            console.log(`Updated user credits: ${userCredits} -> ${userCredits - itemCost}`);
        }

        // Add the item to user_items collection
        await db.collection("user_items").add({
            username,
            item_name,
            item_type,
        });
        console.log(`Added item ${item_name} to user_items for ${username}`);

        res.status(201).json({
            message: "Item purchased successfully",
            remaining_credits: item_type === "Boost" ? userGems - itemCost : userCredits - itemCost
        });
    } catch (error) {
        console.error("Error in buy-item endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});


// 📌 Get all courses a user has started
app.get("/user-courses/:username", async (req, res) => {
    const { username } = req.params;

    try {
        // Step 1: Find all courses the user has started
        const userCoursesRef = db.collection("user_courses").where("username", "==", username);
        const userCoursesSnapshot = await userCoursesRef.get();

        if (userCoursesSnapshot.empty) {
            return res.status(404).json({ error: "No courses found for this user" });
        }

        let coursesStarted = [];

        // Step 2: Fetch details for each course using course_id
        for (const doc of userCoursesSnapshot.docs) {
            let userCourseData = doc.data();

            // Step 3: Find course details in "courses" collection
            const courseRef = db.collection("courses").where("course_id", "==", userCourseData.course_id);
            const courseSnapshot = await courseRef.get();

            if (!courseSnapshot.empty) {
                let courseData = courseSnapshot.docs[0].data(); // Get first match


                let createdAt = userCourseData.time_started ? userCourseData.time_started.toDate().toISOString() : "Unknown";
                // Step 4: Structure response
                coursesStarted.push({
                    course_name: courseData.course_name,
                    numChapters: courseData.numChapters,
                    time_started: createdAt
                });
            }
        }

        res.status(200).json(coursesStarted);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📌 Get all items owned by a user
app.get("/user-items/:username", async (req, res) => {
    const { username } = req.params;
    console.log(`Getting all items owned by user: ${username}`);

    try {
        // Query the user_items collection for this user
        const userItemsRef = db.collection("user_items").where("username", "==", username);
        const userItemsSnapshot = await userItemsRef.get();
        
        if (userItemsSnapshot.empty) {
            console.log(`No items found for user: ${username}`);
            return res.status(404).json({ 
                message: "No items found for this user"
            });
        }

        // Extract item data (just item_name and item_type)
        const items = [];
        
        userItemsSnapshot.forEach(doc => {
            const itemData = doc.data();
            
            items.push({
                item_name: itemData.item_name,
                item_type: itemData.item_type
            });
        });

        res.status(200).json({
            items: items,
        });
        
    } catch (error) {
        console.error("Error in user-items endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Start a new course for a user
app.post("/start-course", async (req, res) => {
    const { username, course_name } = req.body;
    console.log(`Starting course: ${course_name} for user: ${username}`);

    if (!username || !course_name) {
        return res.status(400).json({ error: "Username and course name are required" });
    }

    try {
        // Step 1: Find course
        console.log("Step 1: Finding course in courses collection");
        const courseRef = db.collection("courses").where("course_name", "==", course_name);
        const courseSnapshot = await courseRef.get();

        if (courseSnapshot.empty) {
            console.log(`Course not found: ${course_name}`);
            return res.status(404).json({ error: "Course not found" });
        }

        const courseData = courseSnapshot.docs[0].data();
        const course_id = courseData.course_id;
        const numChapters = courseData.numChapters;
        console.log(`Found course: ${course_name}, ID: ${course_id}, Chapters: ${numChapters}`);

        // Step 2: Check if user already started this course
        console.log("Step 2: Checking if user already started this course");
        const existingUserCourseRef = db.collection("user_courses")
            .where("username", "==", username)
            .where("course_id", "==", course_id);
        
        const existingUserCourse = await existingUserCourseRef.get();
        
        if (!existingUserCourse.empty) {
            console.log(`User ${username} has already started course: ${course_name}`);
            return res.status(400).json({ error: "User has already started this course" });
        }

        // Step 3: Add entry to user_courses collection
        console.log("Step 3: Adding entry to user_courses collection");
        await db.collection("user_courses").add({
            username,
            course_id,
            course_name,
            numChapters,
            time_started: admin.firestore.FieldValue.serverTimestamp(),
            status: "started"
        });
        console.log("Added user_course record successfully");

        // Step 4: Initialize user achievements for this course
        console.log("Step 4: Initializing achievements for this course");
        const courseAchievementsRef = db.collection("achievement").where("course_id", "==", course_id);
        const courseAchievementsSnapshot = await courseAchievementsRef.get();
        
        const achievementPromises = [];
        let achievementCount = 0;
        
        courseAchievementsSnapshot.forEach(doc => {
            const achievementData = doc.data();
            achievementPromises.push(
                db.collection("user_achievements").add({
                    username,
                    achievement_name: achievementData.achievement_name,
                    status: "not completed"
                })
            );
            achievementCount++;
        });
        
        console.log(`Found ${achievementCount} achievements to initialize for this course`);
        
        // Step 5: Get all chapters for this course
        console.log("Step 5: Getting all chapters for this course");
        const chaptersRef = db.collection("chapter").where("course_id", "==", course_id);
        const chaptersSnapshot = await chaptersRef.get();

        if (chaptersSnapshot.empty) {
            console.log(`No chapters found for course ID: ${course_id}`);
            return res.status(500).json({ error: "No chapters found for this course" });
        }

        console.log(`Found ${chaptersSnapshot.size} chapters for course ID: ${course_id}`);

        // OPTIMIZATION: Get all levels for all chapters in parallel
        console.log("Step 6: Getting all levels for all chapters in parallel");
        const userChapterPromises = [];
        const userLevelPromises = [];
        
        // First, prepare all chapter operations
        for (const chapterDoc of chaptersSnapshot.docs) {
            const chapterData = chapterDoc.data();
            const chapter_name = chapterData.chapter_name;
            console.log(`Processing chapter: ${chapter_name}`);

            // Step 6a: Add entry to user_chapters collection
            userChapterPromises.push(
                db.collection("user_chapters").add({
                    username,
                    course_id,
                    chapter_name,
                    status: "not started"
                })
            );
        }
        
        // Now, get all levels for all chapters in parallel
        const levelQueries = [];
        for (const chapterDoc of chaptersSnapshot.docs) {
            const chapterData = chapterDoc.data();
            const chapter_name = chapterData.chapter_name;
            
            levelQueries.push({
                chapterData: chapterData,
                query: db.collection("levels").where("chapter_name", "==", chapter_name).get()
            });
        }
        
        // Execute all level queries in parallel
        const levelResults = await Promise.all(levelQueries.map(item => item.query));
        
        // Process level results
        levelResults.forEach((levelsSnapshot, index) => {
            const chapterData = levelQueries[index].chapterData;
            const chapter_name = chapterData.chapter_name;
            
            if (!levelsSnapshot.empty) {
                console.log(`Found ${levelsSnapshot.size} levels for chapter: ${chapter_name}`);
                
                levelsSnapshot.forEach(levelDoc => {
                    const levelData = levelDoc.data();
                    console.log(`Processing level: ${levelData.level_name}`);
                    
                    if(levelData.isFirst==true && chapterData.isFirst==true){
                        userLevelPromises.push(
                            db.collection("user_levels").add({
                                username,
                                chapter_name,
                                level_name: levelData.level_name,
                                status: "unlocked",
                                score: 0
                            })
                        );
                    }
                    else{
                        userLevelPromises.push(
                            db.collection("user_levels").add({
                                username,
                                chapter_name,
                                level_name: levelData.level_name,
                                status: "locked",
                                score: 0
                            })
                        );
                    }
                });
            } else {
                console.log(`No levels found for chapter: ${chapter_name}`);
            }
        });

        // Execute all database operations
        console.log(`Executing ${userChapterPromises.length} chapter operations, ${userLevelPromises.length} level operations, and ${achievementPromises.length} achievement operations`);
        await Promise.all([...userChapterPromises, ...userLevelPromises, ...achievementPromises]);
        console.log("All database operations completed successfully");

        res.status(201).json({ 
            message: "Course started successfully", 
            course_name, 
            course_id,
            achievements_initialized: achievementCount
        });
        
    } catch (error) {
        console.error("Error in start-course endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});


// 📌 Delete a course and all related data for a user
app.post("/delete-course", async (req, res) => {
    const { username, course_name } = req.body;
    console.log(`Deleting course: ${course_name} for user: ${username}`);

    if (!username || !course_name) {
        return res.status(400).json({ error: "Username and course name are required" });
    }

    try {
        // Step 1: Find the course ID
        console.log("Step 1: Finding course in courses collection");
        const courseRef = db.collection("courses").where("course_name", "==", course_name);
        const courseSnapshot = await courseRef.get();

        if (courseSnapshot.empty) {
            console.log(`Course not found: ${course_name}`);
            return res.status(404).json({ error: "Course not found" });
        }

        const courseData = courseSnapshot.docs[0].data();
        const course_id = courseData.course_id;
        console.log(`Found course: ${course_name}, ID: ${course_id}`);

        // Step 2: Check if user has started this course
        console.log("Step 2: Checking if user has started this course");
        const userCoursesRef = db.collection("user_courses")
            .where("username", "==", username)
            .where("course_id", "==", course_id);
        
        const userCoursesSnapshot = await userCoursesRef.get();
        
        if (userCoursesSnapshot.empty) {
            console.log(`User ${username} has not started course: ${course_name}`);
            return res.status(404).json({ error: "User has not started this course" });
        }

        // Step 3: Begin batch delete operations
        console.log("Step 3: Collecting data to delete");
        const deletePromises = [];
        
        // Step 3a: Delete user_courses entries
        console.log("Deleting user_courses entries");
        userCoursesSnapshot.forEach(doc => {
            deletePromises.push(db.collection("user_courses").doc(doc.id).delete());
        });

        // Step 3b: Get all chapters for this course
        console.log("Step 3b: Finding chapters for this course");
        const userChaptersRef = db.collection("user_chapters")
            .where("username", "==", username)
            .where("course_id", "==", course_id);
        
        const userChaptersSnapshot = await userChaptersRef.get();
        
        // Delete user_chapters entries
        console.log("Deleting user_chapters entries");
        userChaptersSnapshot.forEach(doc => {
            deletePromises.push(db.collection("user_chapters").doc(doc.id).delete());
        });

        // Step 3c: Get chapter names for this course
        const chapterNames = [];
        userChaptersSnapshot.forEach(doc => {
            chapterNames.push(doc.data().chapter_name);
        });
        console.log(`Found ${chapterNames.length} chapters to delete`);

        // Step 3d: Delete all user_levels for these chapters
        console.log("Step 3d: Deleting user_levels for these chapters");
        for (const chapter_name of chapterNames) {
            const userLevelsRef = db.collection("user_levels")
                .where("username", "==", username)
                .where("chapter_name", "==", chapter_name);
            
            const userLevelsSnapshot = await userLevelsRef.get();
            
            userLevelsSnapshot.forEach(doc => {
                deletePromises.push(db.collection("user_levels").doc(doc.id).delete());
            });

            // Keep track of level names for deleting objectives
            userLevelsSnapshot.forEach(doc => {
                const levelData = doc.data();
                console.log(`Will delete level: ${levelData.level_name}`);
            });
        }

        // Step 3e: Delete user_objectives related to this course's levels
        console.log("Step 3e: Finding and deleting user_objectives for this course");
        const userObjectivesRef = db.collection("user_objectives")
            .where("username", "==", username);
        
        const userObjectivesSnapshot = await userObjectivesRef.get();
        
        // Filter to only delete objectives for levels in this course
        const levelNames = new Set();
        
        // Get all level names for this course
        for (const chapter_name of chapterNames) {
            const levelsRef = db.collection("levels")
                .where("chapter_name", "==", chapter_name);
            
            const levelsSnapshot = await levelsRef.get();
            
            levelsSnapshot.forEach(doc => {
                levelNames.add(doc.data().level_name);
            });
        }
        
        console.log(`Found ${levelNames.size} levels in this course`);
        
        // Delete user_objectives for levels in this course
        userObjectivesSnapshot.forEach(doc => {
            const objectiveData = doc.data();
            if (levelNames.has(objectiveData.level_name)) {
                console.log(`Deleting objective for level: ${objectiveData.level_name}`);
                deletePromises.push(db.collection("user_objectives").doc(doc.id).delete());
            }
        });

        // Step 3f: Delete course-specific achievements from user_achievements
        console.log("Step 3f: Finding and deleting course-specific achievements");
        
        // Get all achievements related to this course
        const courseAchievementsRef = db.collection("achievement")
            .where("course_id", "==", course_id);
            
        const courseAchievementsSnapshot = await courseAchievementsRef.get();
        
        // Create a set of achievement names for this course
        const courseAchievementNames = new Set();
        courseAchievementsSnapshot.forEach(doc => {
            courseAchievementNames.add(doc.data().achievement_name);
        });
        
        console.log(`Found ${courseAchievementNames.size} achievements for this course`);
        
        // Get user's achievements
        const userAchievementsRef = db.collection("user_achievements")
            .where("username", "==", username);
            
        const userAchievementsSnapshot = await userAchievementsRef.get();
        
        // Delete user achievements that belong to this course
        let deletedAchievements = 0;
        userAchievementsSnapshot.forEach(doc => {
            const achievementData = doc.data();
            if (courseAchievementNames.has(achievementData.achievement_name)) {
                console.log(`Deleting achievement: ${achievementData.achievement_name}`);
                deletePromises.push(db.collection("user_achievements").doc(doc.id).delete());
                deletedAchievements++;
                
            }
        });
        
        // Step 4: Update user's achievement count if needed
        if (deletedAchievements > 0) {
            console.log(`Step 4: Updating user's achievement count`);
            
            // Count completed achievements that were deleted
            let completedAchievements = 0;
            userAchievementsSnapshot.forEach(doc => {
                const achievementData = doc.data();
                if (courseAchievementNames.has(achievementData.achievement_name) && 
                    achievementData.status === "completed") {
                    completedAchievements++;
                }
            });
            
            if (completedAchievements > 0) {
                console.log(`Decrementing user's achievement count by ${completedAchievements}`);
                
                const userRef = db.collection("users").where("username", "==", username);
                const userSnapshot = await userRef.get();
                
                if (!userSnapshot.empty) {
                    const userDoc = userSnapshot.docs[0];
                    await db.collection("users").doc(userDoc.id).update({
                        numAchievements: admin.firestore.FieldValue.increment(-completedAchievements)
                    });
                }
            }
        }

        // Step 5: Execute all delete operations
        console.log(`Executing ${deletePromises.length} delete operations`);
        await Promise.all(deletePromises);
        console.log("All delete operations completed successfully");

        res.status(200).json({
            message: "Course deleted successfully",
            course_name,
            deletedItems: deletePromises.length,
            deletedAchievements: deletedAchievements
        });
    } catch (error) {
        console.error("Error in delete-course endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});
// 📌 Complete an achievement for a user
app.post("/complete-achievement", async (req, res) => {
    const { username, achievement_name } = req.body;
    console.log(`Completing achievement: ${achievement_name} for user: ${username}`);

    if (!username || !achievement_name) {
        return res.status(400).json({ error: "Username and achievement name are required" });
    }

    try {
        // Step 1: Find the user's achievement in the user_achievements collection
        console.log("Step 1: Finding the user's achievement");
        const userAchievementRef = db.collection("user_achievements")
            .where("username", "==", username)
            .where("achievement_name", "==", achievement_name);
        
        const userAchievementSnapshot = await userAchievementRef.get();

        if (userAchievementSnapshot.empty) {
            console.log(`Achievement not found for user: ${username}, achievement: ${achievement_name}`);
            return res.status(404).json({ error: "Achievement not found for this user" });
        }

        // Check if already completed
        const userAchievementDoc = userAchievementSnapshot.docs[0];
        const userAchievementData = userAchievementDoc.data();
        
        if (userAchievementData.status === "completed") {
            console.log(`Achievement ${achievement_name} already completed by user: ${username}`);
            return res.status(400).json({ error: "Achievement already completed" });
        }

        // Step 2: Get the gem reward from the achievement collection
        console.log("Step 2: Getting gem reward from achievement collection");
        const achievementRef = db.collection("achievement")
            .where("achievement_name", "==", achievement_name);
            
        const achievementSnapshot = await achievementRef.get();
        
        if (achievementSnapshot.empty) {
            console.log(`Achievement details not found: ${achievement_name}`);
            return res.status(404).json({ error: "Achievement details not found" });
        }
        
        const achievementData = achievementSnapshot.docs[0].data();
        const gemsReward = achievementData.gems || 0;
        console.log(`Achievement reward: ${gemsReward} gems`);

        // Step 3: Update user_achievements status to "completed"
        console.log("Step 3: Updating achievement status to completed");
        await db.collection("user_achievements").doc(userAchievementDoc.id).update({
            status: "completed"
        });

        // Step 4: Update user's gem count in the users collection
        console.log("Step 4: Updating user's gem count");
        const userRef = db.collection("users").where("username", "==", username);
        const userSnapshot = await userRef.get();

        if (userSnapshot.empty) {
            console.log(`User not found: ${username}`);
            return res.status(404).json({ error: "User not found" });
        }

        const userDoc = userSnapshot.docs[0];
        await db.collection("users").doc(userDoc.id).update({
            numGems: admin.firestore.FieldValue.increment(gemsReward),
            numAchievements: admin.firestore.FieldValue.increment(1)
        });

        console.log(`Updated user ${username}'s gems (+${gemsReward}) and achievement count`);

        res.status(200).json({
            message: "Achievement completed successfully",
        });
        
    } catch (error) {
        console.error("Error in complete-achievement endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Get all chapters and levels for a user's course
app.get("/course-structure/:username/:course_name", async (req, res) => {
    const { username, course_name } = req.params;
    console.log(`Getting course structure for user: ${username}, course: ${course_name}`);

    try {
        // Step 1: Find the course ID
        console.log("Step 1: Finding course in courses collection");
        const courseRef = db.collection("courses").where("course_name", "==", course_name);
        const courseSnapshot = await courseRef.get();

        if (courseSnapshot.empty) {
            console.log(`Course not found: ${course_name}`);
            return res.status(404).json({ error: "Course not found" });
        }

        const courseData = courseSnapshot.docs[0].data();
        const course_id = courseData.course_id;

        // Step 2: Get all chapters for this course with user progress
        const userChaptersRef = db.collection("user_chapters")
            .where("username", "==", username)
            .where("course_id", "==", course_id);
        
        const userChaptersSnapshot = await userChaptersRef.get();
        
        if (userChaptersSnapshot.empty) {
            return res.status(404).json({ error: "No chapters found for this course" });
        }

        // Step 3: Get all chapter details in parallel
        const chapterNames = userChaptersSnapshot.docs.map(doc => doc.data().chapter_name);
        
        
        // make multiple queries and combine them with Promise.all
        const chapterDetailsQueries = chapterNames.map(name => {
            return db.collection("chapter").where("chapter_name", "==", name).get();
        });
        const chapterDetailsSnapshots = await Promise.all(chapterDetailsQueries);
        
        // Create a map for fast lookup
        const chapterDetailsMap = {};
        chapterDetailsSnapshots.forEach(snapshot => {
            if (!snapshot.empty) {
                const data = snapshot.docs[0].data();
                chapterDetailsMap[data.chapter_name] = data;
            }
        });

        
        // Step 4: Get all user levels for this course
        const userLevelsRef = db.collection("user_levels")
            .where("username", "==", username);
        const userLevelsSnapshot = await userLevelsRef.get();
        
        // Group levels by chapter_name for fast lookup
        const levelsByChapter = {};
        userLevelsSnapshot.forEach(doc => {
            const data = doc.data();
            if (!levelsByChapter[data.chapter_name]) {
                levelsByChapter[data.chapter_name] = [];
            }
            levelsByChapter[data.chapter_name].push(data);
        });

        // Step 5: Get all level details in parallel
        // First gather all level names and chapter names
        const levelQueries = [];
        const levelKeys = [];
        userLevelsSnapshot.forEach(doc => {
            const data = doc.data();
            levelKeys.push(`${data.chapter_name}:${data.level_name}`);
            levelQueries.push(
                db.collection("levels")
                    .where("chapter_name", "==", data.chapter_name)
                    .where("level_name", "==", data.level_name)
                    .get()
            );
        });
        
        const levelDetailsSnapshots = await Promise.all(levelQueries);
        
        // Create a map for fast lookup
        const levelDetailsMap = {};
        levelDetailsSnapshots.forEach((snapshot, index) => {
            if (!snapshot.empty) {
                levelDetailsMap[levelKeys[index]] = snapshot.docs[0].data();
            }
        });

        // Step 6: Build the response structure with chapters and levels
        const chapters = [];
        
        for (const chapterDoc of userChaptersSnapshot.docs) {
            const chapterData = chapterDoc.data();
            const chapter_name = chapterData.chapter_name;
            
            const chapterDetails = chapterDetailsMap[chapter_name] || {};
            
            const levels = [];
            const chapterLevels = levelsByChapter[chapter_name] || [];
            
            for (const levelData of chapterLevels) {
                const levelKey = `${chapter_name}:${levelData.level_name}`;
                const levelDetails = levelDetailsMap[levelKey] || {};

                levels.push({
                    level_name: levelData.level_name,
                    score: levelData.score,
                    status: levelData.status,
                    levelNumber: levelDetails.levelNumber || 0,
                    points: levelDetails.points || 0,
                    isCompleted: levelData.isCompleted || false
                });
            }

            // Sort levels by levelNumber
            levels.sort((a, b) => a.levelNumber - b.levelNumber);
            
            chapters.push({
                chapter_name: chapterData.chapter_name,
                status: chapterData.status,
                levels: levels,
                chapterNumber: chapterDetails.chapterNumber || 0,
            });
        }

        // Sort chapters by chapterNumber
        chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        
        // Return the complete course structure
        const courseStructure = {
            course_name,
            course_id,
            numChapters: courseData.numChapters,
            chapters: chapters
        };
        
        res.status(200).json(courseStructure);
        
    } catch (error) {
        console.error("Error in course-structure endpoint:", error);
        res.status(500).json({ error: error.message });
    }
});


// 📌 Update a level for a user and unlock the next level if completed
app.post("/update-level", async (req, res) => {
    let { username, level_name, chapter_name, level_number, time_taken, score, isFailed, streak_counter } = req.body;
    console.log(`Updating level: ${level_name} for user: ${username}`);

    if (!username || !level_name || !chapter_name || level_number === undefined || 
        time_taken === undefined || score === undefined || isFailed === undefined) {
        return res.status(400).json({ 
            error: "Username, level_name, chapter_name, level_number, time_taken, score, and isFailed are required" 
        });
    }

    try {
        // Convert values to proper types
        time_taken = Number(time_taken);
        score = Number(score);
        level_number = Number(level_number);
        isFailed = isFailed === "true" || isFailed === true;
        
        // Convert streak_counter to number if provided
        if (streak_counter !== undefined) {
            streak_counter = Number(streak_counter);
            if (isNaN(streak_counter)) {
                return res.status(400).json({ error: "streak_counter must be a valid number" });
            }
        }
        
        if (isNaN(time_taken) || isNaN(score) || isNaN(level_number)) {
            return res.status(400).json({ error: "time_taken, score, and level_number must be valid numbers" });
        }
        
        // Step 1: Find the user's level in the user_levels collection
        console.log("Step 1: Finding the user's level");
        const userLevelRef = db.collection("user_levels")
            .where("username", "==", username)
            .where("level_name", "==", level_name)
            .where("chapter_name", "==", chapter_name);

        const userLevelSnapshot = await userLevelRef.get();

        if (userLevelSnapshot.empty) {
            console.log(`Level not found for user: ${username}, level: ${level_name}`);
            return res.status(404).json({ error: "Level not found for this user" });
        }

        const userLevelDoc = userLevelSnapshot.docs[0];
        const userLevelId = userLevelDoc.id;
        const currentLevelData = userLevelDoc.data();
        const currentScore = currentLevelData.score || 0;

        // Step 2: Update the level entry in the user_levels collection
        console.log("Step 2: Updating the level entry");
        const updateData = {
            isCompleted: !isFailed,
            time_taken: time_taken,
        };

        // Only update score if the new score is higher than the current one
        if (score > currentScore) {
            console.log(`Updating score from ${currentScore} to ${score}`);
            updateData.score = score;
        } else {
            console.log(`Keeping existing score ${currentScore} (new score ${score} not higher)`);
            res.status(400).json({
                message: "No update needed, current score is higher or equal"
            });
            return;
        }

        await db.collection("user_levels").doc(userLevelId).update(updateData);
        console.log(`Level ${level_name} updated for user: ${username}`);
        
        // Step 3: Update streak_counter in users collection if provided
        if (streak_counter !== undefined) {
            console.log(`Step 3: Updating streak_counter to ${streak_counter} for user: ${username}`);
            const userRef = db.collection("users").where("username", "==", username);
            const userSnapshot = await userRef.get();
            
            if (!userSnapshot.empty) {
                const userDoc = userSnapshot.docs[0];
                await db.collection("users").doc(userDoc.id).update({
                    streak_counter: streak_counter
                });
                console.log(`Updated streak_counter to ${streak_counter} for user: ${username}`);
            } else {
                console.log(`User not found: ${username}`);
            }
        }

        // Step 4: If level was completed successfully, unlock the next level
        let nextLevelInfo = null;
        if (!isFailed) {
            console.log("Step 4: Unlocking next level");
            
            // Find the next level in the levels collection
            const nextLevelRef = db.collection("levels")
                .where("chapter_name", "==", chapter_name)
                .where("levelNumber", "==", level_number + 1);
            
            const nextLevelSnapshot = await nextLevelRef.get();
            
            if (!nextLevelSnapshot.empty) {
                const nextLevelData = nextLevelSnapshot.docs[0].data();
                const nextLevelName = nextLevelData.level_name;
                
                console.log(`Found next level: ${nextLevelName}`);
                
                // Find the user's next level entry
                const nextUserLevelRef = db.collection("user_levels")
                    .where("username", "==", username)
                    .where("level_name", "==", nextLevelName)
                    .where("chapter_name", "==", chapter_name);
                
                const nextUserLevelSnapshot = await nextUserLevelRef.get();
                
                if (!nextUserLevelSnapshot.empty) {
                    const nextUserLevelDoc = nextUserLevelSnapshot.docs[0];
                    
                    // Update the status to unlocked
                    await db.collection("user_levels").doc(nextUserLevelDoc.id).update({
                        status: "unlocked"
                    });
                    
                    console.log(`Unlocked next level: ${nextLevelName} for user: ${username}`);
                    
                    nextLevelInfo = {
                        level_name: nextLevelName,
                        level_number: level_number + 1
                    };
                } else {
                    console.log(`Next level user entry not found for: ${nextLevelName}`);
                }
            } else {
                console.log("No next level found in this chapter");
            }
        }

        // Prepare response
        const response = {
            message: "Level updated successfully",
        };
        
        // Include streak_counter in response if it was updated
        if (streak_counter !== undefined) {
            response.streak_counter = streak_counter;
        }
        
        // Add next level info if available
        if (nextLevelInfo) {
            response.nextLevel = nextLevelInfo;
        }

        res.status(200).json(response);
    } catch (error) {
        console.error("Error in update-level endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Mark start time for a user's level attempt
app.post("/start-level-time", async (req, res) => {
    const { username, level_name, chapter_name } = req.body;
    console.log(`Setting start time for level: ${level_name} for user: ${username}`);

    if (!username || !level_name || !chapter_name) {
        return res.status(400).json({ error: "Username, level_name, and chapter_name are required" });
    }

    try {
        // Step 1: Find the user's level in the user_levels collection
        console.log("Step 1: Finding the user's level");
        const userLevelRef = db.collection("user_levels")
            .where("username", "==", username)
            .where("level_name", "==", level_name)
            .where("chapter_name", "==", chapter_name);
        
        const userLevelSnapshot = await userLevelRef.get();

        if (userLevelSnapshot.empty) {
            console.log(`Level not found for user: ${username}, level: ${level_name}`);
            return res.status(404).json({ error: "Level not found for this user" });
        }

        const userLevelDoc = userLevelSnapshot.docs[0];
        const userLevelData = userLevelDoc.data();
        
        // Step 2: Check if start_level_time already exists
        if (userLevelData.start_level_time) {
            console.log(`Start time already exists for level: ${level_name}`);
            const formattedTime = userLevelData.start_level_time.toDate().toISOString();
            return res.status(200).json({ 
                message: "Start time already exists",
                start_level_time: formattedTime
            });
        }
        
        // Step 3: Update the document with the current timestamp
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        await db.collection("user_levels").doc(userLevelDoc.id).update({
            start_level_time: timestamp
        });
        
        console.log(`Start time set for level: ${level_name}`);
        
        // Step 4: Fetch the updated document to get the server timestamp
        const updatedDoc = await db.collection("user_levels").doc(userLevelDoc.id).get();
        const updatedData = updatedDoc.data();
        let formattedTimestamp = null;
        
        // The server timestamp might take a moment to be set
        if (updatedData.start_level_time) {
            formattedTimestamp = updatedData.start_level_time.toDate().toISOString();
        }
        
        res.status(200).json({
            message: "Level start time recorded successfully",
            start_level_time: formattedTimestamp
        });
        
    } catch (error) {
        console.error("Error in start-level-time endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Remove an item from user's inventory
app.delete("/user-items/:username/:item_name", async (req, res) => {
    const { username, item_name } = req.params;
    console.log(`Removing item: ${item_name} from user: ${username}`);

    if (!username || !item_name) {
        return res.status(400).json({ error: "Username and item name are required" });
    }

    try {
        // Step 1: Find the item in user_items collection
        console.log(`Step 1: Finding item ${item_name} for user ${username}`);
        const userItemRef = db.collection("user_items")
            .where("username", "==", username)
            .where("item_name", "==", item_name);
        
        const userItemSnapshot = await userItemRef.get();
        
        if (userItemSnapshot.empty) {
            console.log(`Item not found for user: ${username}, item: ${item_name}`);
            return res.status(404).json({ error: "Item not found in user's inventory" });
        }

        // Step 2: Delete the item document
        console.log(`Step 2: Removing item document from user_items collection`);
        const itemDoc = userItemSnapshot.docs[0];
        await db.collection("user_items").doc(itemDoc.id).delete();
        
        console.log(`Successfully removed item: ${item_name} from user: ${username}`);

        res.status(200).json({
            message: "Item successfully removed from inventory",
            item_name: item_name
        });
    } catch (error) {
        console.error("Error in remove-item endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Update an objective to "completed" and update user score
app.post("/complete-objective", async (req, res) => {
    const { username, objective_name } = req.body;
    console.log(`Completing objective: ${objective_name} for user: ${username}`);

    if (!username || !objective_name) {
        return res.status(400).json({ error: "Username and objective name are required" });
    }

    try {
        // Step 1: Find the user's objective in the user_objectives collection
        console.log("Step 1: Finding the user's objective");
        const userObjectiveRef = db.collection("user_objectives")
            .where("username", "==", username)
            .where("objective_name", "==", objective_name);
        
        const userObjectiveSnapshot = await userObjectiveRef.get();

        if (userObjectiveSnapshot.empty) {
            console.log(`Objective not found for user: ${username}, objective: ${objective_name}`);
            return res.status(404).json({ error: "Objective not found for this user" });
        }

        const userObjectiveDoc = userObjectiveSnapshot.docs[0];
        const userObjectiveId = userObjectiveDoc.id;
        const userObjectiveData = userObjectiveDoc.data();

        // Step 2: Check if the objective is already completed
        console.log("Step 2: Checking if objective is already completed");
        if (userObjectiveData.status === "completed") {
            console.log(`Objective ${objective_name} already completed by user: ${username}`);
            return res.status(400).json({ 
                error: "Objective already completed",
                message: "This objective has already been marked as completed"
            });
        }
        
        // Step 2: Update the status of the objective to "completed"
        console.log("Step 2: Updating the objective status to 'completed'");
        await db.collection("user_objectives").doc(userObjectiveId).update({
            status: "completed"
        });

        // Step 3: Retrieve the points for the objective from the objective collection
        console.log("Step 3: Retrieving points for the objective");
        const objectiveRef = db.collection("objective").where("objective_name", "==", objective_name);
        const objectiveSnapshot = await objectiveRef.get();

        if (objectiveSnapshot.empty) {
            console.log(`Objective details not found: ${objective_name}`);
            return res.status(404).json({ error: "Objective details not found" });
        }

        const objectiveData = objectiveSnapshot.docs[0].data();
        const objectivePoints = objectiveData.points || 0;
        console.log(`Objective points: ${objectivePoints}`);

        // Step 4: Update the user's score in the users collection
        console.log("Step 4: Updating the user's score");
        const userRef = db.collection("users").where("username", "==", username);
        const userSnapshot = await userRef.get();

        if (userSnapshot.empty) {
            console.log(`User not found: ${username}`);
            return res.status(404).json({ error: "User not found" });
        }

        const userDoc = userSnapshot.docs[0];
        const userId = userDoc.id;

        await db.collection("users").doc(userId).update({
            score: admin.firestore.FieldValue.increment(objectivePoints)
        });

        console.log(`User ${username}'s score updated by ${objectivePoints} points`);

        res.status(200).json({
            message: "Objective completed and score updated successfully",
        });
    } catch (error) {
        console.error("Error in complete-objective endpoint:", error);
        console.error("Error stack:", error.stack);
        res.status(500).json({ error: error.message });
    }
});

// 📌 Start the server
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Call initVectorStore during server startup
initVectorStore()
  .then((success) => {
    if (success) {
      console.log("RAG system ready");
    } else {
      console.log("RAG system not available - will try to initialize on first request");
    }
  });
