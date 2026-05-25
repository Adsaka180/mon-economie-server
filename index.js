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

// --- CONFIGURATION PERSONNALISABLE PAR SUPER ADMIN ---
let globalSettings = {
    appName: "Économie Virtuelle",
    currencySymbol: "$",
    defaultBalance: 1000,
    xpMultiplier: 1.0,
    registrationEnabled: true,
    maintenanceMode: false,
    themePrimaryColor: "#6200EE"
};

let users = [];
let products = [
    { id: "p1", name: "Pack Fondateur", description: "Un pack exclusif pour les premiers arrivés.", price: 0, stock: 100, category: "Événement", imageUrl: "https://cdn-icons-png.flaticon.com/512/1063/1063376.png", sellerId: "system", salesCount: 0 },
    { id: "p2", name: "Grade VIP+", description: "Deviens une légende de l'économie.", price: 15000, stock: 10, category: "Grades", imageUrl: "https://cdn-icons-png.flaticon.com/512/2583/2583344.png", sellerId: "system", salesCount: 0 }
];
let messages = [];
let logs = [];
let transactions = [];
let titles = [
    { id: "t1", name: "Fondateur", rarity: "EXCLUSIF_ADMIN", color: "#FFD700", animation: "glow", icon: "👑" },
    { id: "t2", name: "Nouveau", rarity: "COMMUN", color: "#FFFFFF", animation: "none", icon: "🌱" }
];

// --- INITIALISATION SUPER ADMIN ---
async function initAdmin() {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    const admin = {
        id: "admin-id", username: "admin", password: hashedPassword,
        balance: 1000000, role: "SUPER_ADMIN", level: 100, xp: 0, reputation: 100,
        title: "Fondateur", isBanned: false, status: "offline", bio: "Le créateur du système.",
        bannerUrl: "https://images.unsplash.com/photo-1557683316-973673baf926",
        profileImageUrl: "https://ui-avatars.com/api/?name=Admin&background=FFD700&color=fff"
    };
    if (!users.find(u => u.username === "admin")) users.push(admin);
}
initAdmin();

function addLog(action, details) {
    const log = { id: uuidv4(), action, details, timestamp: Date.now() };
    logs.unshift(log);
    if (logs.length > 500) logs.pop();
    io.to('admins').emit('new_log', log);
}

// --- API ROUTES ---
app.post('/register', async (req, res) => {
    if (!globalSettings.registrationEnabled) return res.status(403).json({ error: "Inscriptions désactivées" });
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: "Pseudo déjà pris" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
        id: uuidv4(), username, password: hashedPassword, balance: globalSettings.defaultBalance, role: 'USER',
        level: 1, xp: 0, reputation: 0, title: "Nouveau", isBanned: false, status: "offline"
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

    socket.join(socket.userId);
    if (user.role !== 'USER') socket.join('admins');

    socket.emit('initial_data', {
        currentUser: user,
        products,
        titles,
        settings: globalSettings,
        leaderboard: users.sort((a, b) => b.balance - a.balance).slice(0, 50).map(u => ({ id: u.id, username: u.username, balance: u.balance, level: u.level })),
        messages: messages.filter(m => m.receiverId === user.id || m.senderId === user.id || m.receiverId === 'global')
    });

    if (user.role !== 'USER') {
        socket.emit('admin_data', { users, logs, transactions });
    }

    // --- MARKETPLACE ---
    socket.on('buy_product', (data) => {
        const product = products.find(p => p.id === data.productId);
        if (product && product.stock > 0 && user.balance >= product.price) {
            product.stock--;
            user.balance -= product.price;
            user.xp += (50 * globalSettings.xpMultiplier);
            if (user.xp >= user.level * 250) { user.level++; user.xp = 0; }

            io.to(user.id).emit('current_user', user);
            io.emit('product_updated', product);
            addLog("Marketplace", `${user.username} a acheté ${product.name}`);
        }
    });

    // --- ACTIONS SUPER ADMIN (CUSTOMIZATION) ---
    socket.on('super_admin_update_settings', (newSettings) => {
        if (user.role === 'SUPER_ADMIN') {
            globalSettings = { ...globalSettings, ...newSettings };
            io.emit('settings_updated', globalSettings);
            addLog("Settings", "Configuration globale mise à jour");
        }
    });

    socket.on('super_admin_modify_user', (data) => {
        if (user.role === 'SUPER_ADMIN') {
            const target = users.find(u => u.id === data.userId);
            if (target) {
                Object.assign(target, data.updates);
                io.to(target.id).emit('current_user', target);
                io.to('admins').emit('admin_user_updated', target);
                addLog("Admin", `Utilisateur ${target.username} modifié`);
            }
        }
    });

    socket.on('super_admin_manage_title', (data) => {
        if (user.role === 'SUPER_ADMIN') {
            if (data.action === 'create') {
                const newTitle = { id: uuidv4(), ...data.title };
                titles.push(newTitle);
                io.emit('titles_list', titles);
            } else if (data.action === 'delete') {
                titles = titles.filter(t => t.id !== data.titleId);
                io.emit('titles_list', titles);
            }
            addLog("Admin", `Gestion des titres: ${data.action}`);
        }
    });

    socket.on('admin_global_announcement', (data) => {
        if (user.role !== 'USER') {
            io.emit('global_announcement', { text: data.text });
            addLog("Global", `Annonce Admin: ${data.text}`);
        }
    });

    socket.on('disconnect', () => {});
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 SUPER ADMIN ENGINE READY"));
