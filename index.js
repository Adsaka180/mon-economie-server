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

// --- SELF-PING TO KEEP ALIVE ON RENDER ---
const RENDER_EXTERNAL_URL = "https://mon-economie-server.onrender.com";

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

function keepAlive() {
    setInterval(() => {
        http.get(RENDER_EXTERNAL_URL + "/ping", (res) => {
            console.log(`Self-ping status: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`Self-ping error: ${err.message}`);
        });
    }, 10 * 60 * 1000); // Ping toutes les 10 minutes
}

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket']
});

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";

// --- GLOBAL STATE ---
let globalSettings = {
    appName: "Économie Virtuelle",
    currencySymbol: "$",
    defaultBalance: 1000,
    xpMultiplier: 1.0,
    registrationEnabled: true,
    maintenanceMode: false,
    economyEvent: "Normal" // Normal, Inflation (prix x2), Bonus XP (xp x2)
};

let users = [];
let products = [
    { id: "p1", name: "Pack Fondateur", description: "Un pack exclusif pour les premiers arrivés.", price: 0, stock: -1, category: "Événement", imageUrl: "https://cdn-icons-png.flaticon.com/512/1063/1063376.png", sellerId: "system", salesCount: 0 },
    { id: "p2", name: "Grade VIP+", description: "Deviens une légende de l'économie.", price: 15000, stock: -1, category: "Grades", imageUrl: "https://cdn-icons-png.flaticon.com/512/2583/2583344.png", sellerId: "system", salesCount: 0 },
    { id: "p3", name: "Lingot d'Or", description: "Valeur refuge.", price: 5000, stock: 50, category: "Ressources", imageUrl: "https://cdn-icons-png.flaticon.com/512/2481/2481134.png", sellerId: "system", salesCount: 0 }
];
let messages = [];
let logs = [];
let transactions = [];
let reports = [];
let titles = [
    { id: "t1", name: "Fondateur", rarity: "EXCLUSIF_ADMIN", color: "#FFD700", animation: "glow", icon: "👑" },
    { id: "t2", name: "Nouveau", rarity: "COMMUN", color: "#FFFFFF", animation: "none", icon: "🌱" }
];

// --- INITIALISATION ---
async function initAdmin() {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    const admin = {
        id: "admin-id", username: "admin", password: hashedPassword,
        balance: 1000000, role: "SUPER_ADMIN", level: 100, xp: 0, reputation: 100,
        title: "Fondateur", isBanned: false, status: "offline", bio: "Le créateur.",
        badges: ["🛡️ Staff", "💎 Fondateur"], inventory: [], favorites: [], streak: 0, lastDaily: 0
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

// --- API ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: "Pseudo pris" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
        id: uuidv4(), username, password: hashedPassword, balance: globalSettings.defaultBalance, role: 'USER',
        level: 1, xp: 0, reputation: 0, title: "Nouveau", isBanned: false, status: "offline",
        badges: [], inventory: [], favorites: [], streak: 0, lastDaily: 0
    };
    users.push(user);
    addLog("Auth", `Nouveau compte: ${username}`);
    res.json({ token: jwt.sign({ userId: user.id }, JWT_SECRET), user });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (user && !user.isBanned && await bcrypt.compare(password, user.password)) {
        res.json({ token: jwt.sign({ userId: user.id }, JWT_SECRET), user });
    } else if (user && user.isBanned) res.status(403).json({ error: "Banni" });
    else res.status(401).json({ error: "Identifiants invalides" });
});

// --- ENGINE ---
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

    io.emit('user_status', { userId: user.id, status: "online" });

    socket.emit('initial_data', {
        currentUser: user, products, titles, settings: globalSettings,
        leaderboard: users.sort((a, b) => b.balance - a.balance).slice(0, 20),
        messages: messages.slice(-50)
    });

    if (user.role !== 'USER') socket.emit('admin_data', { users, logs, transactions, reports });

    // --- ACTIONS JOUEURS ---
    socket.on('claim_daily', () => {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        if (now - user.lastDaily > oneDay) {
            if (now - user.lastDaily < oneDay * 2) user.streak++; else user.streak = 1;
            const reward = 100 + (user.streak * 50);
            user.balance += reward;
            user.lastDaily = now;
            io.to(user.id).emit('current_user', user);
            io.to(user.id).emit('notification', { message: `Cadeau: +${reward} $ (Série: ${user.streak}j)` });
        } else {
            io.to(user.id).emit('notification', { message: "Déjà récupéré aujourd'hui !" });
        }
    });

    socket.on('buy_product', (data) => {
        const product = products.find(p => p.id === data.productId);
        if (!product) return;

        const alreadyOwned = user.inventory.includes(product.id);
        const canAfford = user.balance >= product.price;
        const hasStock = product.stock > 0 || product.stock === -1;

        if (!alreadyOwned && canAfford && hasStock) {
            if (product.stock !== -1) product.stock--;
            user.balance -= product.price;
            user.inventory.push(product.id);
            user.xp += 50 * globalSettings.xpMultiplier;

            if (user.xp >= user.level * 200) {
                user.level++;
                user.xp = 0;
                io.to(user.id).emit('notification', { message: `Bravo ! Vous passez niveau ${user.level} !` });
            }

            io.to(user.id).emit('current_user', user);
            io.emit('product_updated', product);
            addLog("Market", `${user.username} a acheté ${product.name}`);
        } else if (alreadyOwned) {
            socket.emit('notification', { message: "Vous possédez déjà cet article !" });
        } else if (!hasStock) {
            socket.emit('notification', { message: "Article épuisé !" });
        } else {
            socket.emit('notification', { message: "Solde insuffisant !" });
        }
    });

    socket.on('admin_add_product', (data) => {
        const newProduct = {
            id: uuidv4(),
            name: data.name,
            description: data.description,
            price: parseFloat(data.price),
            stock: parseInt(data.stock), // -1 pour infini
            category: data.category,
            imageUrl: data.imageUrl || "https://cdn-icons-png.flaticon.com/512/1170/1170577.png",
            sellerId: user.id,
            sellerName: user.username,
            salesCount: 0,
            createdAt: Date.now()
        };
        products.push(newProduct);
        io.emit('products_list', products);
        addLog("Market", `${user.username} a mis en vente : ${newProduct.name}`);
    });

    socket.on('admin_delete_product', (data) => {
        if (user.role !== 'USER') {
            products = products.filter(p => p.id !== data.productId);
            io.emit('products_list', products);
            addLog("Admin", `${user.username} a supprimé un produit`);
        }
    });

    socket.on('admin_modify_balance', (data) => {
        if (user.role !== 'USER') {
            const target = users.find(u => u.id === data.userId);
            if (target) {
                target.balance += parseFloat(data.amount);
                io.to(target.id).emit('current_user', target);
                io.to('admins').emit('admin_user_updated', target);
                addLog("Admin", `${user.username} a ajusté le solde de ${target.username} de ${data.amount}`);
            }
        }
    });

    socket.on('admin_global_announcement', (data) => {
        if (user.role !== 'USER') {
            io.emit('global_announcement', { text: data.text });
            addLog("Admin", `Annonce globale: ${data.text}`);
        }
    });

    socket.on('admin_ban_user', (data) => {
        if (user.role !== 'USER') {
            const target = users.find(u => u.id === data.userId);
            if (target && target.role === 'USER') {
                target.isBanned = true;
                io.to(target.id).emit('banned');
                io.to('admins').emit('admin_user_updated', target);
                addLog("Admin", `${user.username} a banni ${target.username}`);
            }
        }
    });

    socket.on('send_message', (data) => {
        const msg = { id: uuidv4(), senderId: user.id, senderName: user.username, content: data.content, timestamp: Date.now() };
        messages.push(msg);
        io.emit('new_message', msg);
    });

    socket.on('report_user', (data) => {
        const report = { id: uuidv4(), reporter: user.username, targetId: data.userId, reason: data.reason, timestamp: Date.now() };
        reports.unshift(report);
        io.to('admins').emit('new_report', report);
        io.to(user.id).emit('notification', { message: "Signalement envoyé aux admins." });
    });

    // --- ACTIONS ADMIN ---
    socket.on('admin_event', (event) => {
        if (user.role !== 'USER') {
            globalSettings.economyEvent = event;
            io.emit('settings_updated', globalSettings);
            io.emit('global_announcement', { text: `ÉVÉNEMENT EN COURS: ${event} !` });
        }
    });

    socket.on('admin_give_badge', (data) => {
        if (user.role === 'SUPER_ADMIN') {
            const target = users.find(u => u.id === data.userId);
            if (target) {
                target.badges.push(data.badge);
                io.to(target.id).emit('current_user', target);
                addLog("Admin", `Badge ${data.badge} donné à ${target.username}`);
            }
        }
    });

    socket.on('disconnect', () => {
        user.status = "offline";
        io.emit('user_status', { userId: user.id, status: "offline" });
    });
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log("🚀 ECO-SYSTEM FULL LOADED");
    keepAlive(); // Démarrer le système d'auto-réveil
});
