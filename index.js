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
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket']
});

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";

// --- BASE DE DONNÉES EN MÉMOIRE ---
let users = [];
let products = [
    { id: "p1", name: "Pack Fondateur", description: "Un pack exclusif pour les premiers arrivés.", price: 0, stock: 100, category: "Événement", imageUrl: "https://cdn-icons-png.flaticon.com/512/1063/1063376.png", sellerId: "system", salesCount: 0 },
    { id: "p2", name: "Grade VIP+", description: "Deviens une légende de l'économie.", price: 15000, stock: 10, category: "Grades", imageUrl: "https://cdn-icons-png.flaticon.com/512/2583/2583344.png", sellerId: "system", salesCount: 0 },
    { id: "p3", name: "Lingot d'Or", description: "Valeur refuge.", price: 5000, stock: 50, category: "Ressources", imageUrl: "https://cdn-icons-png.flaticon.com/512/2481/2481134.png", sellerId: "system", salesCount: 0 }
];
let messages = [];
let logs = [];
let transactions = [];
let titles = [
    { id: "t1", name: "Fondateur", rarity: "EXCLUSIF_ADMIN", color: "#FFD700", animation: "glow" },
    { id: "t2", name: "Nouveau", rarity: "COMMUN", color: "#FFFFFF", animation: "none" }
];

// --- INITIALISATION ADMIN ---
async function initAdmin() {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    const admin = {
        id: "admin-id", username: "admin", password: hashedPassword,
        balance: 1000000, role: "SUPER_ADMIN", level: 100, xp: 0, reputation: 100,
        title: "Fondateur", isBanned: false, status: "online", bio: "Le créateur du système.",
        bannerUrl: "https://images.unsplash.com/photo-1557683316-973673baf926",
        profileImageUrl: "https://ui-avatars.com/api/?name=Admin&background=FFD700&color=fff",
        favorites: [], salesHistory: [], purchaseHistory: []
    };
    users.push(admin);
}
initAdmin();

function addLog(action, details) {
    const log = { id: uuidv4(), action, details, timestamp: Date.now() };
    logs.unshift(log);
    if (logs.length > 500) logs.pop();
    io.to('admins').emit('new_log', log);
}

// --- API AUTH ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: "Pseudo déjà pris" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
        id: uuidv4(), username, password: hashedPassword, balance: 1000, role: 'USER',
        level: 1, xp: 0, reputation: 0, title: "Nouveau", isBanned: false, status: "offline",
        bio: "", bannerUrl: null, profileImageUrl: null, favorites: [],
        salesHistory: [], purchaseHistory: []
    };
    users.push(user);
    addLog("Register", `Nouvel utilisateur: ${username}`);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.json({ token, user });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (user && !user.isBanned && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ userId: user.id }, JWT_SECRET);
        res.json({ token, user });
    } else if (user && user.isBanned) res.status(403).json({ error: "Compte banni" });
    else res.status(401).json({ error: "Identifiants invalides" });
});

// --- REAL-TIME ENGINE ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Auth error"));
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Auth error"));
        socket.userId = decoded.userId;
        next();
    });
});

io.on('connection', (socket) => {
    const user = users.find(u => u.id === socket.userId);
    if (!user) return;

    user.status = "online";
    socket.join(user.id);
    if (user.role !== 'USER') socket.join('admins');

    console.log(`✅ ${user.username} connecté`);
    io.emit('user_status_change', { userId: user.id, status: "online" });

    // Envoi initial complet pour la synchro directe
    socket.emit('initial_data', {
        currentUser: user,
        products,
        titles,
        leaderboard: users.sort((a, b) => b.balance - a.balance).slice(0, 50).map(u => ({ id: u.id, username: u.username, balance: u.balance, level: u.level })),
        messages: messages.filter(m => m.receiverId === user.id || m.senderId === user.id || m.receiverId === 'global')
    });

    if (user.role !== 'USER') {
        socket.emit('admin_data', { users, logs, transactions });
    }

    // --- MARKETPLACE ACTIONS ---
    socket.on('buy_product', (data) => {
        const product = products.find(p => p.id === data.productId);
        if (product && product.stock > 0 && user.balance >= product.price) {
            // Transaction atomique
            product.stock--;
            product.salesCount++;
            user.balance -= product.price;
            user.xp += 50;
            user.purchaseHistory.push({ productId: product.id, name: product.name, price: product.price, date: Date.now() });

            // Créditer le vendeur
            const seller = users.find(u => u.id === product.sellerId);
            if (seller) {
                seller.balance += product.price;
                seller.xp += 30;
                seller.salesHistory.push({ productId: product.id, name: product.name, price: product.price, buyerName: user.username, date: Date.now() });
                io.to(seller.id).emit('current_user', seller);
                io.to(seller.id).emit('notification', { message: `Vente réussie: ${product.name} (+${product.price} $)` });
            }

            // Level up check
            if (user.xp >= user.level * 250) {
                user.level++;
                user.xp = 0;
                io.to(user.id).emit('notification', { message: `Félicitations ! Vous êtes passé au niveau ${user.level} ! 🎉` });
            }

            const tx = { id: uuidv4(), senderId: user.id, receiverId: product.sellerId, amount: product.price, details: `Achat: ${product.name}`, timestamp: Date.now(), type: 'PURCHASE' };
            transactions.unshift(tx);

            io.to(user.id).emit('current_user', user);
            io.emit('product_updated', product);
            io.to('admins').emit('new_transaction', tx);
            io.to(user.id).emit('notification', { message: `Achat de ${product.name} confirmé !` });
            addLog("Marketplace", `${user.username} a acheté ${product.name}`);
        }
    });

    // --- COMMUNICATION ---
    socket.on('send_message', (data) => {
        const msg = { id: uuidv4(), senderId: user.id, senderName: user.username, content: data.content, receiverId: data.receiverId || 'global', timestamp: Date.now() };
        messages.push(msg);
        if (messages.length > 1000) messages.shift();

        if (msg.receiverId === 'global') io.emit('new_message', msg);
        else {
            io.to(msg.receiverId).emit('new_message', msg);
            io.to(user.id).emit('new_message', msg);
        }
    });

    socket.on('typing', (data) => {
        socket.to(data.receiverId === 'global' ? 'global' : data.receiverId).emit('user_typing', { userId: user.id, username: user.username });
    });

    // --- ACTIONS SUPER ADMIN ---
    socket.on('admin_create_title', (data) => {
        if (user.role === 'SUPER_ADMIN') {
            const newTitle = { id: uuidv4(), ...data };
            titles.push(newTitle);
            io.emit('title_created', newTitle);
            addLog("Admin", `Nouveau titre créé: ${data.name}`);
        }
    });

    socket.on('admin_assign_title', (data) => {
        if (user.role === 'SUPER_ADMIN') {
            const target = users.find(u => u.id === data.userId);
            if (target) {
                target.title = data.titleName;
                io.to(target.id).emit('current_user', target);
                addLog("Admin", `Titre ${data.titleName} attribué à ${target.username}`);
            }
        }
    });

    socket.on('admin_global_announcement', (data) => {
        if (user.role !== 'USER') {
            io.emit('global_announcement', { text: data.text });
            addLog("Global", `Annonce Admin: ${data.text}`);
        }
    });

    socket.on('claim_daily', () => {
        const reward = 100 + (user.level * 10);
        user.balance += reward;
        user.xp += 20;
        io.to(user.id).emit('current_user', user);
        io.to(user.id).emit('notification', { message: `Cadeau quotidien récupéré: +${reward} $` });
    });

    socket.on('disconnect', () => {
        user.status = "offline";
        io.emit('user_status_change', { userId: user.id, status: "offline" });
        console.log(`❌ ${user.username} déconnecté`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 SERVEUR ULTIME ÉCONOMIE ACTIF SUR ${PORT}`));
