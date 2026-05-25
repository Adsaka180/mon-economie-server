require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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

const JWT_SECRET = process.env.JWT_SECRET || "secret_super_securise_999";

// --- STOCKAGE EN MÉMOIRE (FIABLE ET RAPIDE) ---
let users = [];
let products = [
    { id: "p1", name: "Pack de démarrage", description: "Idéal pour débuter l'aventure", price: 100, stock: 99, category: "Général" },
    { id: "p2", name: "Grade VIP", description: "Badge doré sur le profil", price: 5000, stock: 10, category: "Spécial" },
    { id: "p3", name: "Épée en Diamant", description: "Objet de collection rarissime", price: 50000, stock: 1, category: "Légendaire" }
];

// Création automatique du compte admin
async function initAdmin() {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    users.push({
        id: "admin-static-id",
        username: "admin",
        password: hashedPassword,
        balance: 1000000.0,
        role: "SUPER_ADMIN",
        level: 100,
        reputation: 100,
        xp: 0,
        title: "Fondateur"
    });
    console.log("👑 Compte Admin prêt : admin / admin123");
}
initAdmin();

// --- ROUTES AUTHENTIFICATION ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Champs requis" });
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ error: "Ce nom est déjà pris" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: uuidv4(), username, password: hashedPassword,
        balance: 1000.0, role: 'USER', level: 1, xp: 0, reputation: 0, title: "Nouveau"
    };
    users.push(newUser);

    const token = jwt.sign({ userId: newUser.id }, JWT_SECRET);
    res.json({ token, user: newUser });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ userId: user.id }, JWT_SECRET);
        const { password, ...userWithoutPassword } = user;
        res.json({ token, user: userWithoutPassword });
    } else {
        res.status(401).json({ error: "Identifiants incorrects" });
    }
});

// --- TEMPS RÉEL (SOCKET.IO) ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) return next(new Error("Erreur Auth"));
            socket.userId = decoded.userId;
            next();
        });
    } else next(new Error("Erreur Auth"));
});

io.on('connection', (socket) => {
    console.log(`🔌 Connecté : ${socket.userId}`);
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
            console.log(`🛒 Achat : ${user.username} a acheté ${product.name}`);
        }
    });

    socket.on('disconnect', () => console.log("❌ Déconnecté"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SERVEUR ÉCONOMIE PRÊT SUR LE PORT ${PORT}`);
});
