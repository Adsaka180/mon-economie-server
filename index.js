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

const JWT_SECRET = process.env.JWT_SECRET || "secret_par_defaut_123";

// --- BASE DE DONNÉES TEMPORAIRE (MÉMOIRE) ---
// Si MongoDB échoue, on utilise ces listes
let users = [];
let products = [
    { id: "p1", name: "Pack de démarrage", description: "Idéal pour débuter", price: 100, stock: 50, category: "Général" },
    { id: "p2", name: "Badge VIP", description: "Accès exclusif", price: 5000, stock: 10, category: "Spécial" }
];

// Tentative de connexion MongoDB (sans bloquer le serveur)
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log("✅ MongoDB Cloud connecté"))
        .catch(err => console.log("⚠️ Mode mémoire activé (DB non configurée)"));
} else {
    console.log("ℹ️ Utilisation du mode mémoire (Pas de MONGODB_URI)");
}

// Création du Super Admin en mémoire par défaut
async function initAdmin() {
    const adminExists = users.find(u => u.username === "admin");
    if (!adminExists) {
        const hashedPassword = await bcrypt.hash("admin123", 10);
        users.push({
            id: "admin-id",
            username: "admin",
            password: hashedPassword,
            role: "SUPER_ADMIN",
            balance: 1000000.0,
            title: "Fondateur",
            level: 100,
            reputation: 100,
            xp: 0
        });
        console.log("👑 Identifiants Admin prêts : admin / admin123");
    }
}
initAdmin();

// --- ROUTES AUTH ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: "Déjà pris" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: uuidv4(), username, password: hashedPassword, balance: 1000.0, role: 'USER', level: 1, xp: 0 };
    users.push(newUser);

    const token = jwt.sign({ userId: newUser.id }, JWT_SECRET);
    res.json({ token, user: newUser });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ userId: user.id }, JWT_SECRET);
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

io.on('connection', (socket) => {
    socket.join(socket.userId);
    socket.emit('products_list', products);

    socket.on('buy_product', (data) => {
        const product = products.find(p => p.id === data.productId);
        const user = users.find(u => u.id === socket.userId);

        if (product && user && product.stock > 0 && user.balance >= product.price) {
            product.stock -= 1;
            user.balance -= product.price;
            io.to(socket.userId).emit('update_balance', { balance: user.balance });
            io.emit('product_sold', product);
        }
    });

    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur actif sur le port ${PORT}`);
});
