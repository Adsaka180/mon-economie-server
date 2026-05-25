require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const mongoURI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/economie";
const JWT_SECRET = process.env.JWT_SECRET || "secret_par_defaut_123";

mongoose.connect(mongoURI)
    .then(() => {
        console.log("✅ Base de données connectée");
        seedAdmin(); // Créer le super admin au démarrage
    })
    .catch(err => console.error("❌ Erreur DB:", err));

// Modèles
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000.0 },
    role: { type: String, default: 'USER' }, // USER, ADMIN, SUPER_ADMIN
    level: { type: Number, default: 1 },
    reputation: { type: Number, default: 0 },
    xp: { type: Number, default: 0 },
    title: { type: String, default: "Nouveau" }
});
const User = mongoose.model('User', UserSchema);

// Fonction pour créer le Super Admin par défaut
async function seedAdmin() {
    const adminExists = await User.findOne({ username: "admin" });
    if (!adminExists) {
        const hashedPassword = await bcrypt.hash("admin123", 10);
        const admin = new User({
            username: "admin",
            password: hashedPassword,
            role: "SUPER_ADMIN",
            balance: 1000000.0,
            title: "Créateur"
        });
        await admin.save();
        console.log("👑 Super Admin créé: admin / admin123");
    }
}

// --- ROUTES AUTH ---
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: "Champs manquants" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();

        const token = jwt.sign({ userId: newUser._id }, JWT_SECRET);
        res.json({ token, user: newUser });
    } catch (e) {
        res.status(400).json({ error: "Nom d'utilisateur déjà pris" });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ userId: user._id }, JWT_SECRET);
        res.json({ token, user });
    } else {
        res.status(401).json({ error: "Identifiants incorrects" });
    }
});

// --- SOCKET.IO ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) return next(new Error("Auth Error"));
            socket.userId = decoded.userId;
            next();
        });
    } else next(new Error("Auth Error"));
});

io.on('connection', async (socket) => {
    socket.join(socket.userId);
    console.log(`Connecté: ${socket.userId}`);

    socket.on('disconnect', () => console.log("Déconnecté"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});
